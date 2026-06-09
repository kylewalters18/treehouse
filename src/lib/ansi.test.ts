import { describe, it, expect } from "vitest";
import { ansiToSegments, stripAnsi } from "./ansi";

const ESC = "\x1b";

describe("ansiToSegments", () => {
  it("returns one unstyled segment for plain text", () => {
    expect(ansiToSegments("hello world")).toEqual([{ text: "hello world", style: undefined }]);
  });

  it("colors text between an SGR set and reset", () => {
    const segs = ansiToSegments(`pre ${ESC}[31mred${ESC}[0m post`);
    expect(segs.map((s) => s.text)).toEqual(["pre ", "red", " post"]);
    expect(segs[1].style).toMatchObject({ color: "#f87171" });
    expect(segs[0].style).toBeUndefined();
    expect(segs[2].style).toBeUndefined();
  });

  it("combines bold + color in one style", () => {
    const segs = ansiToSegments(`${ESC}[1;32mok${ESC}[0m`);
    expect(segs[0].style).toMatchObject({ fontWeight: "bold", color: "#4ade80" });
  });

  it("handles 256-color and truecolor foregrounds", () => {
    expect(ansiToSegments(`${ESC}[38;5;196mx${ESC}[0m`)[0].style?.color).toBe("rgb(255,0,0)");
    expect(ansiToSegments(`${ESC}[38;2;10;20;30mx${ESC}[0m`)[0].style?.color).toBe("rgb(10,20,30)");
  });

  it("drops non-SGR CSI sequences like erase-line", () => {
    const segs = ansiToSegments(`a${ESC}[0Kb${ESC}[2Kc`);
    expect(segs.map((s) => s.text).join("")).toBe("abc");
  });

  it("strips GitLab section markers and the trailing CR", () => {
    const raw = `${ESC}[0Ksection_start:1700000000:build_step\r${ESC}[0K${ESC}[32mRunning${ESC}[0m`;
    const segs = ansiToSegments(raw);
    const text = segs.map((s) => s.text).join("");
    expect(text).toBe("Running");
    expect(text).not.toContain("section_start");
  });

  it("preserves newlines and drops lone carriage returns", () => {
    expect(ansiToSegments("a\nb").map((s) => s.text).join("")).toBe("a\nb");
    expect(ansiToSegments("a\rb").map((s) => s.text).join("")).toBe("ab");
  });
});

describe("stripAnsi", () => {
  it("yields clean plain text", () => {
    const raw = `${ESC}[0Ksection_start:1:s\r${ESC}[0K${ESC}[1;31mError:${ESC}[0m boom${ESC}[0K`;
    expect(stripAnsi(raw)).toBe("Error: boom");
  });
});
