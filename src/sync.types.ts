import { Identifier, StixObject } from "@security-alliance/stix/2.1";
import type { Operation } from "fast-json-patch";

// The server uses Partial<UserOrigin> for all events. User-initiated events
// typically have socket/ip/user_id/group_ids/organization_ids. Synthetic events
// (dependencies, recovery) typically only have referer. All fields are optional.
//
// Note: the server's TypeScript UserOrigin interface is incomplete — `ip` and
// `call_retry_number` are set at runtime (in userWithOrigin and httpServer)
// but missing from the type definition.
export type EventOrigin = {
    socket?: string;
    ip?: string;
    name?: string;
    user_id?: string;
    group_ids?: string[];
    organization_ids?: string[];
    applicant_id?: string;
    playbook_id?: string;
    call_retry_number?: string;
    referer?: string;
    user_metadata?: object;
};

export type CreateEvent = {
    data: StixObject;
    message: string;
    origin: EventOrigin;
};

export type UpdateEvent = {
    data: StixObject;
    message: string;
    origin: EventOrigin;
    context: {
        patch: Operation[];
        reverse_patch: Operation[];
    };
};

export type DeleteEvent = {
    data: StixObject;
    message: string;
    origin: EventOrigin;
};

export type MergeEvent = {
    data: StixObject;
    message: string;
    origin: EventOrigin;
    context: {
        patch: Operation[];
        reverse_patch: Operation[];
        sources: StixObject[];
    };
};

export type ReadyState = "idle" | "connecting" | "syncing" | "ready" | "stopped";

/** Metadata from the server's "connected" SSE event (Redis XINFO STREAM). */
export type StreamInfo = {
    connectionId: string;
    firstEventId: string;
    lastEventId: string;
    firstEventDate: string;
    lastEventDate: string;
    streamSize: number;
};

export type ReadyStateChangeEvent =
    | { readyState: "connecting"; reason: string }
    | { readyState: "syncing"; info: StreamInfo }
    | { readyState: "ready" }
    | { readyState: "stopped" };

export type UpdateType = "heartbeat" | "create" | "update" | "delete" | "merge";

export type StateUpdateEvent =
    | { lastEventId: string; updateType: "heartbeat"; body: string }
    | { lastEventId: string; updateType: "create"; body: CreateEvent }
    | { lastEventId: string; updateType: "update"; body: UpdateEvent }
    | { lastEventId: string; updateType: "delete"; body: DeleteEvent }
    | { lastEventId: string; updateType: "merge"; body: MergeEvent };

export type OpenCTIStreamOptions<T = StixObject> = {
    signal?: AbortSignal;
    state?: OpenCTIStreamStateManager<T>;
    noDependencies?: boolean;
    noDelete?: boolean;
    withInferences?: boolean;

    authorization?: string;
};

export interface OpenCTIStreamStateManager<T = StixObject> {
    initialize(): Promise<void>;

    getLastEventId(): string;

    getObjects(): Record<Identifier, T>;
    getObject(id: Identifier): T | undefined;

    updateState(events: StateUpdateEvent[]): Promise<void>;
    replaceState(objects: Record<Identifier, StixObject>, lastEventId: string): Promise<void>;
}
