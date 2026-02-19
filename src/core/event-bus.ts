/**
 * Event Bus — Typed pub/sub for decoupling components.
 */
import type { BrainEvent, EventHandler } from '../types';

export class CognitiveEventBus {
    private handlers: Map<string, Set<EventHandler>> = new Map();
    private globalHandlers: Set<EventHandler> = new Set();

    /** Subscribe to a specific event type */
    on(eventType: string, handler: EventHandler): void {
        if (!this.handlers.has(eventType)) {
            this.handlers.set(eventType, new Set());
        }
        this.handlers.get(eventType)!.add(handler);
    }

    /** Subscribe to ALL events */
    onAll(handler: EventHandler): void {
        this.globalHandlers.add(handler);
    }

    /** Unsubscribe from a specific event type */
    off(eventType: string, handler: EventHandler): void {
        this.handlers.get(eventType)?.delete(handler);
    }

    /** Emit an event to all matching handlers */
    async emit(eventType: string, event: BrainEvent): Promise<void> {
        const typeHandlers = this.handlers.get(eventType);
        const promises: Promise<void>[] = [];

        if (typeHandlers) {
            for (const handler of typeHandlers) {
                const result = handler(event);
                if (result instanceof Promise) {
                    promises.push(result);
                }
            }
        }

        for (const handler of this.globalHandlers) {
            const result = handler(event);
            if (result instanceof Promise) {
                promises.push(result);
            }
        }

        if (promises.length > 0) {
            await Promise.allSettled(promises);
        }
    }

    /** Clear all handlers */
    clear(): void {
        this.handlers.clear();
        this.globalHandlers.clear();
    }
}
