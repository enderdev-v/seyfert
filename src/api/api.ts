import { randomUUID, type UUID } from 'node:crypto';
import { type Awaitable, BASE_HOST, delay, Logger, lazyLoadPackage, snowflakeToTimestamp } from '../common';
import { toArrayBuffer, toBuffer } from '../common/it/utils';
import type { WorkerData } from '../websocket';
import type { WorkerSendApiRequest } from '../websocket/discord/worker';
import { Bucket } from './bucket';
import { CDNRouter, Router } from './Router';
import type { APIRoutes } from './Routes';
import {
	type ApiHandlerInternalOptions,
	type ApiHandlerOptions,
	type ApiRequestOptions,
	DefaultUserAgent,
	type HttpMethods,
	type RawFile,
	type RequestHeaders,
} from './shared';
import { isBufferLike } from './utils/utils';

export interface ApiHandler {
	/* @internal */
	_proxy_?: APIRoutes;
	debugger?: Logger;
	/* @internal */
	workerData?: WorkerData;
}

export type OnRatelimitCallback = (response: Response, request: ApiRequestOptions) => Awaitable<any>;

export class ApiHandler {
	options: ApiHandlerInternalOptions;
	globalBlock = false;
	ratelimits = new Map<string, Bucket>();
	readyQueue: (() => void)[] = [];
	cdn = CDNRouter.createProxy();
	workerPromises?: Map<string, { resolve: (value: any) => any; reject: (error: any) => any }>;
	onRatelimit?: OnRatelimitCallback;

	constructor(options: ApiHandlerOptions) {
		this.options = {
			baseUrl: 'api/v10',
			domain: BASE_HOST,
			type: 'Bot',
			...options,
			userAgent: DefaultUserAgent,
		};
		if (options.debug) this.debug = true;

		const worker_threads = lazyLoadPackage<typeof import('node:worker_threads')>('node:worker_threads');

		if (options.workerProxy && !worker_threads?.parentPort && !process.send)
			throw new Error('Cannot use workerProxy without a parent.');
		if (options.workerProxy) this.workerPromises = new Map();

		if (worker_threads?.parentPort) {
			this.sendMessage = async body => {
				worker_threads.parentPort!.postMessage(
					body,
					body.requestOptions.files
						?.filter(x => !['string', 'boolean', 'number'].includes(typeof x.data))
						.map(x => (x.data instanceof Buffer ? toArrayBuffer(x.data) : (x.data as ArrayBuffer))),
				);
			};
		} else if (process.send) {
			this.sendMessage = body => {
				const data = {
					...body,
					requestOptions: {
						...body.requestOptions,
						files: body.requestOptions.files?.map(file => {
							if (file.data instanceof ArrayBuffer) file.data = toBuffer(file.data);
							return file;
						}),
					},
				};
				process.send!(data);
			};
		}
	}

	set debug(active: boolean) {
		this.debugger = active
			? new Logger({
					name: '[API]',
				})
			: undefined;
	}

	get proxy() {
		return (this._proxy_ ??= new Router(this).createProxy());
	}

	globalUnblock() {
		this.globalBlock = false;
		let cb: (() => void) | undefined;
		while ((cb = this.readyQueue.shift())) {
			cb();
		}
	}

	randomUUID(): UUID {
		const uuid = randomUUID();
		if (this.workerPromises!.has(uuid)) return this.randomUUID();
		return uuid;
	}

	protected sendMessage(_body: WorkerSendApiRequest) {
		throw new Error('Function not implemented');
	}

	protected postMessage<T = unknown>(body: WorkerSendApiRequest) {
		this.sendMessage(body);
		return new Promise<T>((res, rej) => {
			this.workerPromises!.set(body.nonce, { reject: rej, resolve: res });
		});
	}

	async request<T = unknown>(
		method: HttpMethods,
		url: `/${string}`,
		{ auth = true, ...request }: ApiRequestOptions = {},
	): Promise<T> {
		if (this.options.workerProxy) {
			const nonce = this.randomUUID();
			return this.postMessage<T>({
				method,
				url,
				type: 'WORKER_API_REQUEST',
				workerId: this.workerData!.workerId,
				nonce,
				requestOptions: { auth, ...request },
			});
		}
		const route = request.route || this.routefy(url, method);
		let attempts = 0;

		const callback = async (next: () => void, resolve: (data: any) => void, reject: (err: unknown) => void) => {
			const headers = {
				'User-Agent': this.options.userAgent,
			} satisfies RequestHeaders;

			const { data, finalUrl } = this.parseRequest({
				url,
				headers,
				request: { ...request, auth },
			});

			let response: Response;

			try {
				const url = `${this.options.domain}/${this.options.baseUrl}${finalUrl}`;
				this.debugger?.debug(`Sending, Method: ${method} | Url: [${finalUrl}](${route}) | Auth: ${auth}`);
				response = await fetch(url, {
					method,
					headers,
					body: data,
				});
				this.debugger?.debug(`Received response: ${response.statusText}(${response.status})`);
			} catch (err) {
				this.debugger?.debug('Fetch error', err);
				next();
				reject(err);
				return;
			}

			const now = Date.now();
			const headerNow = Date.parse(response.headers.get('date') ?? '');

			this.setRatelimitsBucket(route, response);
			this.setResetBucket(route, response, now, headerNow);

			let result: string | Record<string, any> = await response.text();

			if (response.status >= 300) {
				if (response.status === 429) {
					const result429 = await this.handle429(route, method, url, request, response, result, next, reject, now);
					if (result429 !== false) return resolve(result429);
					return this.clearResetInterval(route);
				}
				if ([502, 503].includes(response.status) && ++attempts < 4) {
					this.clearResetInterval(route);
					return this.handle50X(method, url, request, next);
				}
				this.clearResetInterval(route);
				next();
				if (result.length > 0) {
					if (response.headers.get('content-type')?.includes('application/json')) {
						try {
							result = JSON.parse(result);
						} catch (err) {
							this.debugger?.warn('Error parsing result error (', result, ')', err);
							reject(err);
							return;
						}
					}
				}
				const parsedError = this.parseError(method, route, response, result);
				this.debugger?.warn(parsedError);
				reject(parsedError);
				return;
			}

			if (result.length > 0) {
				if (response.headers.get('content-type')?.includes('application/json')) {
					try {
						result = JSON.parse(result);
					} catch (err) {
						this.debugger?.warn('Error parsing result (', result, ')', err);
						next();
						reject(err);
						return;
					}
				}
			}

			next();
			return resolve(result || undefined);
		};

		return new Promise((resolve, reject) => {
			if (this.globalBlock && auth) {
				this.readyQueue.push(() => {
					if (!this.ratelimits.has(route)) {
						this.ratelimits.set(route, new Bucket(1));
					}
					this.ratelimits.get(route)!.push({ next: callback, resolve, reject }, request.unshift);
				});
			} else {
				if (!this.ratelimits.has(route)) {
					this.ratelimits.set(route, new Bucket(1));
				}
				this.ratelimits.get(route)!.push({ next: callback, resolve, reject }, request.unshift);
			}
		});
	}

	parseError(method: HttpMethods, route: `/${string}`, response: Response, result: string | Record<string, any>) {
		let errMessage = '';
		if (typeof result === 'object') {
			errMessage += `${result.message ?? 'Unknown'} ${result.code ?? ''}\n[${response.status} ${response.statusText}] ${method} ${route}`;

			if ('errors' in result) {
				const errors = this.parseValidationError(result.errors);
				errMessage += `\n${errors.join('\n') || JSON.stringify(result.errors, null, 2)}`;
			}
		} else {
			errMessage = `[${response.status} ${response.statusText}] ${method} ${route}`;
		}
		return new Error(errMessage);
	}

	parseValidationError(data: Record<string, any>, path = '', errors: string[] = []) {
		for (const key in data) {
			if (key === '_errors') {
				for (const error of data[key]) {
					errors.push(`${path.slice(0, -1)} [${error.code}]: ${error.message}`);
				}
			} else if (typeof data[key] === 'object') {
				this.parseValidationError(data[key], `${path}${key}.`, errors);
			}
		}

		return errors;
	}

	async handle50X(method: HttpMethods, url: `/${string}`, request: ApiRequestOptions, next: () => void) {
		const wait = Math.floor(Math.random() * 1900 + 100);
		this.debugger?.warn(`Handling a 50X status, retrying in ${wait}ms`);
		next();
		await delay(wait);
		return this.request(method, url, {
			body: request.body,
			auth: request.auth,
			reason: request.reason,
			route: request.route,
			unshift: true,
		});
	}

	async handle429(
		route: string,
		method: HttpMethods,
		url: `/${string}`,
		request: ApiRequestOptions,
		response: Response,
		result: string,
		next: () => void,
		reject: (err: unknown) => void,
		now: number,
	) {
		await this.onRatelimit?.(response, request);

		const content = `${JSON.stringify(request)} `;
		let retryAfter: number | undefined;

		const data = JSON.parse(result);
		if (data.retry_after) retryAfter = Math.ceil(data.retry_after * 1000);

		retryAfter ??=
			Number(response.headers.get('x-ratelimit-reset-after') || response.headers.get('retry-after')) * 1000;

		if (Number.isNaN(retryAfter)) {
			this.debugger?.warn(`${route} Could not extract retry_after from 429 response. ${result}`);
			next();
			reject(new Error('Could not extract retry_after from 429 response.'));
			return false;
		}

		this.debugger?.info(
			`${
				response.headers.get('x-ratelimit-global') ? 'Global' : 'Unexpected'
			} 429: ${result.slice(0, 256)}\n${content} ${now} ${route} ${response.status}: ${this.ratelimits.get(route)!.remaining}/${
				this.ratelimits.get(route)!.limit
			} left | Reset ${retryAfter} (${this.ratelimits.get(route)!.reset - now}ms left) | Scope ${response.headers.get(
				'x-ratelimit-scope',
			)}`,
		);
		if (retryAfter) {
			await delay(retryAfter);
			next();
			return this.request(method, url, {
				body: request.body,
				auth: request.auth,
				reason: request.reason,
				route: request.route,
				unshift: true,
			});
		}
		next();
		return this.request(method, url, {
			body: request.body,
			auth: request.auth,
			reason: request.reason,
			route: request.route,
			unshift: true,
		});
	}

	clearResetInterval(route: string) {
		clearInterval(this.ratelimits.get(route)!.processingResetAfter as NodeJS.Timeout);
		this.ratelimits.get(route)!.processingResetAfter = undefined;
		this.ratelimits.get(route)!.resetAfter = 0;
	}

	setResetBucket(route: string, resp: Response, now: number, headerNow: number) {
		const retryAfter = Number(resp.headers.get('x-ratelimit-reset-after') || resp.headers.get('retry-after')) * 1000;

		if (retryAfter >= 0) {
			if (resp.headers.get('x-ratelimit-global')) {
				this.globalBlock = true;
				setTimeout(() => this.globalUnblock(), retryAfter || 1);
			} else {
				this.ratelimits.get(route)!.reset = (retryAfter || 1) + now;
			}
		} else if (resp.headers.get('x-ratelimit-reset')) {
			let resetTime = +resp.headers.get('x-ratelimit-reset')! * 1000;
			if (route.endsWith('/reactions/:id') && +resp.headers.get('x-ratelimit-reset')! * 1000 - headerNow === 1000) {
				resetTime = now + 250;
			}
			this.ratelimits.get(route)!.reset = Math.max(resetTime, now);
		} else {
			this.ratelimits.get(route)!.reset = now;
		}
	}

	setRatelimitsBucket(route: string, resp: Response) {
		if (resp.headers.has('x-ratelimit-limit')) {
			this.ratelimits.get(route)!.limit = +resp.headers.get('x-ratelimit-limit')!;
		}

		this.ratelimits.get(route)!.remaining =
			resp.headers.get('x-ratelimit-remaining') === undefined ? 1 : +resp.headers.get('x-ratelimit-remaining')!;

		if (this.options.smartBucket) {
			if (
				resp.headers.has('x-ratelimit-reset-after') &&
				!this.ratelimits.get(route)!.resetAfter &&
				Number(resp.headers.get('x-ratelimit-limit')) === Number(resp.headers.get('x-ratelimit-remaining')) + 1
			) {
				this.ratelimits.get(route)!.resetAfter = +resp.headers.get('x-ratelimit-reset-after')! * 1000;
			}

			if (this.ratelimits.get(route)!.resetAfter && !this.ratelimits.get(route)!.remaining) {
				this.ratelimits.get(route)!.triggerResetAfter();
			}
		}
	}

	parseRequest(options: { url: string; headers: RequestHeaders; request: ApiRequestOptions }) {
		let finalUrl = options.url;
		let data: string | FormData | undefined;
		if (options.request.auth) {
			options.headers.Authorization = `${this.options.type} ${options.request.token || this.options.token}`;
		}
		if (options.request.query) {
			finalUrl += `?${new URLSearchParams(options.request.query)}`;
		}
		if (options.request.files?.length) {
			const formData = new FormData();

			for (const [index, file] of options.request.files.entries()) {
				const fileKey = file.key ?? `files[${index}]`;

				if (isBufferLike(file.data)) {
					formData.append(fileKey, new Blob([file.data], { type: file.contentType }), file.filename);
				} else {
					formData.append(fileKey, new Blob([`${file.data}`], { type: file.contentType }), file.filename);
				}
			}

			if (options.request.body) {
				if (options.request.appendToFormData) {
					for (const [key, value] of Object.entries(options.request.body)) {
						formData.append(key, value);
					}
				} else {
					formData.append('payload_json', JSON.stringify(options.request.body));
				}
			}
			data = formData;
		} else if (options.request.body) {
			options.headers['Content-Type'] = 'application/json';
			data = JSON.stringify(options.request.body);
		}
		if (options.request.reason) {
			options.headers['X-Audit-Log-Reason'] = encodeURIComponent(options.request.reason);
		}
		return { data, finalUrl } as { data: typeof data; finalUrl: `/${string}` };
	}

	routefy(url: string, method: HttpMethods): `/${string}` {
		if (url.startsWith('/interactions/') && url.endsWith('/callback')) {
			return '/interactions/:id/:token/callback';
		}

		let route = url
			.replace(/\/([a-z-]+)\/(?:[0-9]{17,19})/g, (match, p) =>
				p === 'channels' || p === 'guilds' || p === 'webhooks' ? match : `/${p}/:id`,
			)
			.replace(/\/reactions\/[^/]+/g, '/reactions/:id')
			.replace(/\/reactions\/:id\/[^/]+/g, '/reactions/:id/:userID')
			.replace(/^\/webhooks\/(\d+)\/[A-Za-z0-9-_]{64,}/, '/webhooks/$1/:token');

		if (method === 'DELETE' && route.endsWith('/messages/:id')) {
			const messageID = url.slice(url.lastIndexOf('/') + 1);
			const createdAt = Number(snowflakeToTimestamp(messageID));
			if (Date.now() - createdAt >= 1000 * 60 * 60 * 24 * 14) {
				method += '_OLD';
			} else if (Date.now() - createdAt <= 1000 * 10) {
				method += '_NEW';
			}
			route = method + route;
		} else if (method === 'GET' && /\/guilds\/[0-9]+\/channels$/.test(route)) {
			route = '/guilds/:id/channels';
		}
		if (method === 'PUT' || method === 'DELETE') {
			const index = route.indexOf('/reactions');
			if (index !== -1) {
				route = `MODIFY${route.slice(0, index + 10)}`;
			}
		}
		return route as `/${string}`;
	}
}

export type RequestOptions = Pick<ApiRequestOptions, 'reason' | 'auth' | 'appendToFormData' | 'token'>;

export type RestArguments<
	B extends Record<string, any> | undefined,
	Q extends never | Record<string, any> = never,
	F extends RawFile[] = RawFile[],
> = (
	| {
			body: B;
			files?: F;
	  }
	| (Q extends never | undefined
			? {}
			: {
					query?: Q;
				})
) &
	RequestOptions;

export type RestArgumentsNoBody<Q extends never | Record<string, any> = never> = {
	query?: Q;
	files?: RawFile[];
} & RequestOptions;
