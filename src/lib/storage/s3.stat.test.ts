import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, logs } = vi.hoisted(() => ({
  send: vi.fn(),
  logs: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@aws-sdk/client-s3", () => {
  class HeadObjectCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class GetObjectCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class ListObjectsV2Command {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class S3Client {
    send = send;
  }
  return { S3Client, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command };
});

vi.mock("@/lib/logger", () => ({
  getLogger: () => logs,
}));

vi.mock("@/lib/metrics", () => ({
  metrics: { errors: { inc: vi.fn() } },
}));

process.env.S3_ENDPOINT = "https://example.digitaloceanspaces.com";
process.env.S3_BUCKET = "crm-test";
process.env.S3_ACCESS_KEY = "test-key";
process.env.S3_SECRET = "test-secret";

import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { probeStoredFile, statStoredFile } from "@/lib/storage/s3";

const ORG = "cmrmbn2lh0uz2nm016beqgbwb";

function notFound(name = "NoSuchKey") {
  const err = new Error(name);
  err.name = name;
  Object.assign(err, { $metadata: { httpStatusCode: 404 } });
  return err;
}

function forbidden() {
  const err = new Error("AccessDenied");
  err.name = "AccessDenied";
  Object.assign(err, { $metadata: { httpStatusCode: 403 } });
  return err;
}

describe("storage.s3 stat/probe", () => {
  beforeEach(() => {
    send.mockReset();
    logs.debug.mockReset();
    logs.warn.mockReset();
    logs.error.mockReset();
  });

  it("Head 404 é miss: sem Range e sem GetObject", async () => {
    send.mockRejectedValueOnce(notFound());
    await expect(statStoredFile(ORG, "automation-media", "auto_1.mp4")).resolves.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(logs.warn).not.toHaveBeenCalled();
    expect(logs.debug).toHaveBeenCalledWith(
      { key: `${ORG}/automation-media/auto_1.mp4` },
      "storage-s3: HeadObject miss",
    );
  });

  it("probe Head 404 é miss: uma chamada, sem warn de stack", async () => {
    send.mockRejectedValueOnce(notFound("NotFound"));
    await expect(probeStoredFile(ORG, "attachments", "clip.MP4")).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("Head 200 com ContentLength não dispara Range/Get", async () => {
    send.mockResolvedValueOnce({ ContentLength: 42 });
    await expect(statStoredFile(ORG, "automation-media", "auto_1.mp4")).resolves.toEqual({
      size: 42,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  });

  it("Head 200 sem ContentLength cai em Range (quirk Spaces)", async () => {
    send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof HeadObjectCommand) return {};
      if (cmd instanceof GetObjectCommand) {
        return { ContentRange: "bytes 0-0/99", ContentLength: 1, Body: { destroy: () => {} } };
      }
      throw new Error("unexpected command");
    });
    await expect(statStoredFile(ORG, "automation-media", "auto_1.jpg")).resolves.toEqual({
      size: 99,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[1][0] as { input: { Range?: string } }).input.Range).toBe(
      "bytes=0-0",
    );
  });

  it("Head 403 cai em Range e para no hit", async () => {
    send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof HeadObjectCommand) throw forbidden();
      if (cmd instanceof GetObjectCommand) {
        return { ContentRange: "bytes 0-0/12", Body: { destroy: () => {} } };
      }
      throw new Error("unexpected command");
    });
    await expect(statStoredFile(ORG, "inbound-media", "in_1.mp4")).resolves.toEqual({
      size: 12,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(logs.warn).toHaveBeenCalled();
  });
});
