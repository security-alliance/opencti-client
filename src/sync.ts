/*
opencti stream implementation is stupid and is impossible to consistently sync from
- there are two parameters, from and recovery
- syncing loads everything up to recovery from elasticsearch, then everything from recovery
  to from (if from > recovery) from redis. if from < recovery, then it skips elasticsearch
- recovery loads the entire state of the world and sends synthetic create events
- redis loads deltas, including updates/deletes, as patches
- there is no mechanism to ensure consistency between redis and elasticsearch
- if a filter changes, the entire state of the world may change

the design choice we have made here is to use recovery for the initial sync, and then trust
redis for incremental updates. on reconnection, we check whether our cursor is still within
the redis stream (via firstEventId from the server's connected event). if redis has been
trimmed past our position, we automatically trigger a full resync. this is because recovery
doesn't send delete events, so once we are outside redis stream range we can no longer guarantee
consistency without a full resync
*/

import { Identifier, StixObject, StixObjectType, StixObjectTypeMap } from "@security-alliance/stix/2.1";
import EventEmitter from "events";
import { ErrorEvent, EventSource, EventSourceFetchInit } from "eventsource";
import { readFile, rename, writeFile } from "fs/promises";
import { sleep } from "./utils.js";

export type {
    CreateEvent,
    DeleteEvent,
    EventOrigin,
    MergeEvent,
    OpenCTIStreamOptions,
    OpenCTIStreamStateManager,
    ReadyState,
    ReadyStateChangeEvent,
    StateUpdateEvent,
    StreamInfo,
    UpdateEvent,
    UpdateType,
} from "./sync.types.js";

import type {
    CreateEvent,
    DeleteEvent,
    MergeEvent,
    OpenCTIStreamOptions,
    OpenCTIStreamStateManager,
    ReadyState,
    ReadyStateChangeEvent,
    StateUpdateEvent,
    StreamInfo,
    UpdateEvent,
    UpdateType,
} from "./sync.types.js";
import { randomUUID } from "crypto";

const isValidUpdateType = (updateType: string): updateType is UpdateType => {
    return (
        updateType === "heartbeat" ||
        updateType === "create" ||
        updateType === "update" ||
        updateType === "delete" ||
        updateType === "merge"
    );
};

const compareEventIds = (a: string, b: string): -1 | 0 | 1 => {
    const [aTimeStr, aSeqStr] = a.split("-");
    const [bTimeStr, bSeqStr] = b.split("-");

    const aTime = parseInt(aTimeStr);
    const bTime = parseInt(bTimeStr);

    if (aTime > bTime) return -1;
    if (aTime < bTime) return 1;

    const aSeq = parseInt(aSeqStr);
    const bSeq = parseInt(bSeqStr);

    if (aSeq > bSeq) return -1;
    if (aSeq < bSeq) return 1;

    return 0;
};

export class InMemoryOpenCTIStreamStateManager implements OpenCTIStreamStateManager {
    protected lastEventId: string;
    protected objects: Record<Identifier, StixObject>;

    constructor() {
        this.lastEventId = "0-0";
        this.objects = {};
    }

    async initialize(): Promise<void> {}

    getLastEventId(): string {
        return this.lastEventId;
    }

    getObjects(): Record<string, StixObject> {
        return this.objects;
    }

    getObject<T extends StixObjectType>(id: Identifier<T>): StixObjectTypeMap[T] | undefined {
        return this.objects[id] as StixObjectTypeMap[T];
    }

    async updateState(events: StateUpdateEvent[]): Promise<void> {
        if (events.length === 0) return;

        for (const event of events) {
            switch (event.updateType) {
                case "create":
                case "update":
                case "merge":
                    this.objects[event.body.data.id] = event.body.data;
                    if (event.updateType === "merge") {
                        for (const source of event.body.context.sources) {
                            delete this.objects[source.id];
                        }
                    }
                    break;
                case "delete":
                    delete this.objects[event.body.data.id];
                    break;
            }
        }

        this.lastEventId = events[events.length - 1].lastEventId;
    }

    async replaceState(objects: Record<Identifier, StixObject>, lastEventId: string): Promise<void> {
        this.objects = objects;
        this.lastEventId = lastEventId;
    }
}

export class FilesystemOpenCTIStreamStateManager extends InMemoryOpenCTIStreamStateManager {
    private path: string;
    private commitFrequency: number;

    private commitChain: Promise<void> = Promise.resolve();
    private changes = 0;
    private lastCommittedTime = Date.now();

    constructor(path: string, commitFrequency?: number) {
        super();

        this.path = path;
        this.commitFrequency = commitFrequency || 1000 * 60;
    }

    async initialize(): Promise<void> {
        try {
            const data = JSON.parse(await readFile(this.path, "utf-8"));

            this.lastEventId = data["lastEventId"];
            this.objects = data["objects"];
        } catch (e: any) {
            if (e.code !== "ENOENT") throw e;
        }
    }

    async updateState(events: StateUpdateEvent[]): Promise<void> {
        await super.updateState(events);
        this.changes += events.length;

        if (Date.now() - this.lastCommittedTime > this.commitFrequency && this.changes > 0) {
            await this.commitState();
        }
    }

    async replaceState(objects: Record<Identifier, StixObject>, lastEventId: string): Promise<void> {
        await super.replaceState(objects, lastEventId);

        await this.commitState();
    }

    private commitState(): Promise<void> {
        this.changes = 0;

        const data = JSON.stringify({ lastEventId: this.lastEventId, objects: this.objects }, undefined, 2);
        const tempFile = `${this.path}.${randomUUID()}.tmp`;

        this.commitChain = this.commitChain
            .catch(() => {})
            .then(async () => {
                await writeFile(tempFile, data, "utf-8");
                await rename(tempFile, this.path);
                this.lastCommittedTime = Date.now();
            });

        return this.commitChain;
    }
}

const MAX_RECONNECT_DELAY = 60_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const LIVENESS_CHECK_INTERVAL = 30_000;

export class OpenCTIStream extends EventEmitter<{
    create: [CreateEvent];
    update: [UpdateEvent];
    delete: [DeleteEvent];
    merge: [MergeEvent];

    readystatechange: [ReadyStateChangeEvent];
    error: [ErrorEvent];
    connectionError: [ErrorEvent];
}> {
    private stream: URL;
    private noDependencies: boolean;
    private noDelete: boolean;
    private withInferences: boolean;
    private authorization: string | undefined;

    private state: OpenCTIStreamStateManager;

    private signal: AbortSignal | undefined;

    private _readyState: ReadyState;

    private eventSource: EventSource | undefined;

    private streamInfo: StreamInfo | undefined;

    private livenessChecker: NodeJS.Timeout | undefined;

    private reconnectDelay: number;

    private pendingEvents: StateUpdateEvent[] = [];
    private processing = false;

    constructor(stream: URL, options?: OpenCTIStreamOptions) {
        super();

        this.stream = stream;
        this.noDependencies = options?.noDependencies !== undefined ? options.noDependencies : false;
        this.noDelete = options?.noDelete !== undefined ? options.noDelete : false;
        this.withInferences = options?.withInferences !== undefined ? options.withInferences : false;
        this.authorization = options?.authorization;

        this.state = options?.state || new InMemoryOpenCTIStreamStateManager();
        this.signal = options?.signal;

        this.signal?.addEventListener("abort", () => this.stop());

        this._readyState = "idle";

        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
    }

    get readyState(): ReadyState {
        return this._readyState;
    }

    get stateObjects(): Record<string, StixObject> {
        return this.state.getObjects();
    }

    public async start() {
        if (this._readyState !== "idle") return;

        await this.state.initialize();

        this.createEventSource("starting");
    }

    public stop() {
        if (this._readyState === "stopped") return;
        this._readyState = "stopped";

        clearInterval(this.livenessChecker);
        this.eventSource?.close();
        this.emit("readystatechange", { readyState: "stopped" });
    }

    public async resync(): Promise<void> {
        if (this._readyState === "stopped") return;

        this.teardownEventSource();
        await this.resetState("resync");
    }

    private teardownEventSource() {
        clearInterval(this.livenessChecker);
        this.eventSource?.close();
        this.pendingEvents = [];
    }

    private async resetState(reason: string): Promise<void> {
        await this.state.replaceState({}, "0-0");
        this.createEventSource(reason);
    }

    private createEventSource(reason: string) {
        if (this._readyState === "stopped") return;

        this._readyState = "connecting";
        this.emit("readystatechange", { readyState: "connecting", reason: reason });

        const eventSource = new EventSource(new URL("invalid://"), {
            fetch: async (_: string | URL, init: EventSourceFetchInit) => {
                if (this.authorization) {
                    init.headers["authorization"] = `Bearer ${this.authorization}`;
                }

                return fetch(this.constructStreamUrl(), init);
            },
        });

        eventSource.addEventListener("error", (e) => {
            this.emit("connectionError", e);
        });

        eventSource.addEventListener("connected", async (e) => {
            const body = JSON.parse(e.data) as StreamInfo;

            this.streamInfo = body;
            this.reconnectDelay = INITIAL_RECONNECT_DELAY;

            const lastEventId = this.state.getLastEventId();
            const isInitialSync = lastEventId === "0-0";
            const hasGap = !isInitialSync && compareEventIds(lastEventId, body.firstEventId) === 1;

            if (isInitialSync || hasGap) {
                this._readyState = "syncing";
                this.emit("readystatechange", { readyState: "syncing", info: body });

                if (hasGap) {
                    this.teardownEventSource();
                    try {
                        await this.resetState("gap detected");
                    } catch (err: any) {
                        this.emit(
                            "error",
                            new ErrorEvent("error", { message: `gap resync failed: ${err?.message ?? err}` }),
                        );
                        this.stop();
                    }
                    return;
                }
            }

            this.tryMarkReady(lastEventId);
        });

        const handleEvent = (event: MessageEvent) => {
            const updateType = event.type;
            if (!isValidUpdateType(updateType)) {
                this.emit("error", new ErrorEvent("error", { message: `invalid update type: ${updateType}` }));
                return;
            }

            this.pendingEvents.push({
                lastEventId: event.lastEventId,
                updateType: updateType,
                body: JSON.parse(event.data),
            });
            if (!this.processing) this.processQueue();
        };

        eventSource.addEventListener("heartbeat", handleEvent);
        eventSource.addEventListener("create", handleEvent);
        eventSource.addEventListener("update", handleEvent);
        eventSource.addEventListener("delete", handleEvent);
        eventSource.addEventListener("merge", handleEvent);

        this.eventSource = eventSource;

        clearInterval(this.livenessChecker);
        this.livenessChecker = setInterval(() => {
            if (eventSource.readyState !== EventSource.CLOSED) return;

            this.reconnect("liveness checker detected closed event source");
        }, LIVENESS_CHECK_INTERVAL);
    }

    private async reconnect(reason: string) {
        if (this._readyState === "stopped") return;

        this.teardownEventSource();

        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);

        await sleep(delay, this.signal);

        this.createEventSource(reason);
    }

    private async processQueue() {
        this.processing = true;
        while (this.pendingEvents.length > 0) {
            const events = this.pendingEvents;
            this.pendingEvents = [];

            try {
                await this.state.updateState(events);
            } catch (e: any) {
                this.emit("error", new ErrorEvent("error", { message: `failed to commit changes: ${e.toString()}` }));
                this.stop();
                return;
            }

            for (const event of events) if (event.updateType !== "heartbeat") this.emit(event.updateType, event.body);

            this.tryMarkReady(events[events.length - 1].lastEventId);
        }
        this.processing = false;
    }

    private constructStreamUrl(): string {
        const lastEventId = this.state.getLastEventId();

        const streamUrl = new URL(this.stream);

        streamUrl.search = "";
        streamUrl.searchParams.set("from", lastEventId);
        streamUrl.searchParams.set("no-dependencies", this.noDependencies ? "true" : "false");
        streamUrl.searchParams.set("listen-delete", this.noDelete ? "false" : "true");
        streamUrl.searchParams.set("with-inferences", this.withInferences ? "true" : "false");
        if (lastEventId === "0-0") streamUrl.searchParams.set("recover", new Date().toISOString());

        return streamUrl.toString();
    }

    private tryMarkReady(lastEventId: string) {
        if (this._readyState !== "connecting" && this._readyState !== "syncing") return;

        if (compareEventIds(lastEventId, this.streamInfo!.lastEventId!) === 1) return;

        this._readyState = "ready";
        this.emit("readystatechange", { readyState: "ready" });
    }
}
