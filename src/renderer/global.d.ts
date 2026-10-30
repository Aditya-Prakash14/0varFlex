export {};

declare global {
	interface Window {
		host: {
			ping(payload: string): Promise<{ pong: string; from: string }>;
		};
	}
}
