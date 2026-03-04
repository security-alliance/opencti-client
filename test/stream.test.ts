import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { v4 } from "uuid";
import { OpenCTIClient, OpenCTIStream, CreateEvent, DeleteEvent, ReadyStateChangeEvent } from "../src/index.js";

const client = new OpenCTIClient("http://localhost:8080", "00000000-0000-0000-0000-000000000000");

async function waitForReady(stream: OpenCTIStream, timeout = 60_000): Promise<void> {
    if (stream.readyState === "ready") return;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("stream did not become ready")), timeout);
        const handler = (e: ReadyStateChangeEvent) => {
            if (e.readyState === "ready") {
                clearTimeout(timer);
                stream.off("readystatechange", handler);
                resolve();
            }
            if (e.readyState === "stopped") {
                clearTimeout(timer);
                stream.off("readystatechange", handler);
                reject(new Error("stream closed"));
            }
        };
        stream.on("readystatechange", handler);
    });
}

async function waitForEvent(predicate: () => boolean, timeout = 15_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) {
            throw new Error("timed out waiting for event");
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

describe("Stream", { timeout: 120_000 }, () => {
    let streamCollectionId: string;
    let labelId: string;
    let ac: AbortController;
    let stream: OpenCTIStream;
    const creates: CreateEvent[] = [];
    const deletes: DeleteEvent[] = [];

    before(async () => {
        // Create a unique label for this test run
        const label = await client.labelAdd({ input: { value: "test-stream-" + v4(), color: "#000000" } });
        assert.ok(label, "failed to create label");
        labelId = label.id;

        // Create a stream filtered to only this label
        const filters = JSON.stringify({
            mode: "and",
            filters: [{ key: ["objectLabel"], operator: "eq", values: [labelId], mode: "or" }],
            filterGroups: [],
        });
        const sc = await client.streamCollectionAdd({
            input: { name: "test-stream-" + v4(), stream_live: true, stream_public: true, filters },
        });
        assert.ok(sc, "failed to create stream collection");
        streamCollectionId = sc.id;

        // Now connect
        ac = new AbortController();
        stream = client.openStream(streamCollectionId, { signal: ac.signal, noDelete: false });
        stream.on("create", (e) => creates.push(e));
        stream.on("delete", (e) => deletes.push(e));

        await stream.start();
    });

    after(async () => {
        ac.abort();
        if (streamCollectionId) {
            await client.streamCollectionEdit({ id: streamCollectionId }).delete();
        }
        if (labelId) {
            await client.labelEdit({ id: labelId }).delete();
        }
    });

    it("should connect and reach ready state", async () => {
        await waitForReady(stream);
        assert.equal(stream.readyState, "ready");
    });

    it("should receive create events for new labeled entities", async () => {
        const name = "Stream Create Test " + v4();
        const tag = await client.threatActorGroupAdd({
            input: { name, objectLabel: [labelId] },
        });
        assert.ok(tag);

        await waitForEvent(() => creates.some((e) => e.data.id === tag.standard_id));

        const matched = creates.find((e) => e.data.id === tag.standard_id)!;
        assert.ok(matched, "should have received a create event");
        assert.ok(stream.stateObjects[tag.standard_id], "state should contain the new entity");
    });

    it("should not receive events for unlabeled entities", async () => {
        const name = "Stream Unlabeled Test " + v4();
        const tag = await client.threatActorGroupAdd({ input: { name } });
        assert.ok(tag);

        // Wait a bit and verify we did NOT receive it
        await new Promise((r) => setTimeout(r, 3000));
        const matched = creates.find((e) => e.data.id === tag.standard_id);
        assert.equal(matched, undefined, "should not have received an event for unlabeled entity");
    });

    it("should receive delete events", async () => {
        const name = "Stream Delete Test " + v4();
        const tag = await client.threatActorGroupAdd({
            input: { name, objectLabel: [labelId] },
        });
        assert.ok(tag);

        await waitForEvent(() => creates.some((e) => e.data.id === tag.standard_id));

        await client.threatActorGroupEdit({ id: tag.id }).delete();

        await waitForEvent(() => deletes.some((e) => e.data.id === tag.standard_id));

        const matched = deletes.find((e) => e.data.id === tag.standard_id)!;
        assert.ok(matched, "should have received a delete event");
    });
});

describe("Stream resync", { timeout: 180_000 }, () => {
    let streamCollectionId: string;
    let labelId: string;

    before(async () => {
        const label = await client.labelAdd({ input: { value: "test-resync-" + v4(), color: "#000000" } });
        assert.ok(label);
        labelId = label.id;

        const filters = JSON.stringify({
            mode: "and",
            filters: [{ key: ["objectLabel"], operator: "eq", values: [labelId], mode: "or" }],
            filterGroups: [],
        });
        const sc = await client.streamCollectionAdd({
            input: { name: "test-resync-" + v4(), stream_live: true, stream_public: true, filters },
        });
        assert.ok(sc);
        streamCollectionId = sc.id;
    });

    after(async () => {
        if (streamCollectionId) {
            await client.streamCollectionEdit({ id: streamCollectionId }).delete();
        }
        if (labelId) {
            await client.labelEdit({ id: labelId }).delete();
        }
    });

    it("should resync and rebuild state from scratch", async () => {
        // Create entities before connecting
        const tag1 = await client.threatActorGroupAdd({
            input: { name: "Resync Test 1 " + v4(), objectLabel: [labelId] },
        });
        const tag2 = await client.threatActorGroupAdd({
            input: { name: "Resync Test 2 " + v4(), objectLabel: [labelId] },
        });
        assert.ok(tag1);
        assert.ok(tag2);

        await new Promise((r) => setTimeout(r, 2000));

        const ac = new AbortController();
        const stream = client.openStream(streamCollectionId, { signal: ac.signal });

        try {
            await stream.start();
            await waitForReady(stream);

            assert.ok(stream.stateObjects[tag1.standard_id], "should have tag1 before resync");
            assert.ok(stream.stateObjects[tag2.standard_id], "should have tag2 before resync");

            const countBefore = Object.keys(stream.stateObjects).length;

            await stream.resync();
            await waitForReady(stream);

            const countAfter = Object.keys(stream.stateObjects).length;
            assert.ok(countAfter > 0, "should have objects after resync");
            assert.ok(stream.stateObjects[tag1.standard_id], "should still have tag1 after resync");
            assert.ok(stream.stateObjects[tag2.standard_id], "should still have tag2 after resync");
            assert.equal(
                countAfter,
                countBefore,
                `resync should produce same count: before=${countBefore} after=${countAfter}`,
            );

            assert.equal(stream.readyState, "ready", "stream should be ready after resync");
        } finally {
            ac.abort();
        }
    });
});
