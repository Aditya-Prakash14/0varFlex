export {};

declare global {
	interface Window {
		host: {
			ping(payload: string): Promise<{ pong: string; from: string }>;
			ipc: {
				send(message: unknown): void;
				onMessage(handler: (message: unknown) => void): void;
			};
		};
	}
}
