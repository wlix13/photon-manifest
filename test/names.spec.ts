import { describe, expect, it } from "vitest";
import { BadRequest } from "../src/errors";
import { normalizeName, parseDistFilename, versionsEquivalent } from "../src/names";

describe("normalizeName", () => {
  it("collapses separators and lowercases (PEP 503)", () => {
    expect(normalizeName("Friendly.Bard_Package")).toBe("friendly-bard-package");
    expect(normalizeName("my--pkg__x..y")).toBe("my-pkg-x-y");
    expect(normalizeName("simple")).toBe("simple");
  });
});

describe("parseDistFilename", () => {
  it("parses wheel filenames", () => {
    expect(parseDistFilename("my_pkg-1.0.0-py3-none-any.whl")).toEqual({
      project: "my-pkg",
      version: "1.0.0",
      filetype: "bdist_wheel",
    });
  });

  it("parses wheels with a build tag", () => {
    expect(parseDistFilename("my_pkg-1.0.0-1-py3-none-any.whl").version).toBe("1.0.0");
  });

  it("parses sdist filenames", () => {
    expect(parseDistFilename("my-pkg-1.0.0.tar.gz")).toEqual({
      project: "my-pkg",
      version: "1.0.0",
      filetype: "sdist",
    });
  });

  it("rejects unknown extensions", () => {
    expect(() => parseDistFilename("my_pkg-1.0.0.egg")).toThrow(BadRequest);
    expect(() => parseDistFilename("my_pkg-1.0.0.zip")).toThrow(BadRequest);
  });

  it("rejects malformed and unsafe names", () => {
    expect(() => parseDistFilename("justaname.whl")).toThrow(BadRequest);
    expect(() => parseDistFilename("a/../b-1.0.tar.gz")).toThrow(BadRequest);
    expect(() => parseDistFilename(".hidden-1.0.tar.gz")).toThrow(BadRequest);
  });
});

describe("versionsEquivalent", () => {
  it("treats -, _ and . as equivalent separators", () => {
    expect(versionsEquivalent("1.0.0", "1.0.0")).toBe(true);
    expect(versionsEquivalent("1.0.0_1", "1.0.0-1")).toBe(true);
    expect(versionsEquivalent("1.0.0", "1.0.1")).toBe(false);
  });
});
