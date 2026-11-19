import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractWheelMetadata } from "../src/metadata";
import { buildWheel } from "./helpers";

const METADATA = "demo-1.0.0.dist-info/METADATA";

function wheelWith(metadata: Uint8Array): Uint8Array {
  return zipSync({ [METADATA]: metadata, "demo/__init__.py": strToU8("") });
}

function forgeLocalUncompressed(wheel: Uint8Array, declared: number): Uint8Array {
  const copy = wheel.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  for (let i = 0; i + 26 <= copy.length; i++) {
    if (view.getUint32(i, true) === 0x04034b50) {
      view.setUint32(i + 22, declared, true);
    }
  }
  return copy;
}

describe("extractWheelMetadata bounds", () => {
  it("extracts metadata from a normal wheel", async () => {
    const wheel = buildWheel("demo", "1.0.0");
    const out = await extractWheelMetadata(wheel.bytes);
    expect(out).not.toBeNull();
    expect(new TextDecoder().decode(out!)).toContain("Name: demo");
  });

  it("rejects metadata that decompresses past the budget", async () => {
    const wheel = wheelWith(new Uint8Array(64 * 1024 * 1024));
    expect(await extractWheelMetadata(wheel)).toBeNull();
  });

  it("rejects forged huge declared size on tiny real payload", async () => {
    const wheel = forgeLocalUncompressed(wheelWith(strToU8("Name: demo\n")), 0xfffffff0);
    expect(await extractWheelMetadata(wheel)).toBeNull();
  });

  it("takes only the first matching entry", async () => {
    const wheel = zipSync({
      [METADATA]: strToU8("Name: demo\n"),
      "other-1.0.0.dist-info/METADATA": strToU8("Name: other\n"),
    });
    const out = await extractWheelMetadata(wheel);
    expect(new TextDecoder().decode(out!)).toContain("Name: demo");
  });

  it("rejects forged small declared size with huge real payload", async () => {
    const wheel = forgeLocalUncompressed(wheelWith(new Uint8Array(4 * 1024 * 1024)), 1024);
    expect(await extractWheelMetadata(wheel)).toBeNull();
  });

  it("accepts legitimate large metadata", async () => {
    const largeMeta = strToU8("Name: demo\n" + "x".repeat(512 * 1024));
    const wheel = wheelWith(largeMeta);
    const out = await extractWheelMetadata(wheel);
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThanOrEqual(512 * 1024);
  });

  it("extracts uncompressed (stored) metadata entry", async () => {
    const wheel = zipSync({ [METADATA]: strToU8("Name: demo\n") }, { level: 0 });
    const out = await extractWheelMetadata(wheel);
    expect(out).not.toBeNull();
    expect(new TextDecoder().decode(out!)).toContain("Name: demo");
  });
});
