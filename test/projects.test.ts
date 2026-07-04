import { describe, it, expect } from "vitest";
import {
  buildProjectsKeyboard,
  renderProjectsRich,
  shortenHome,
  topicDeepLink,
  PROJECTS_MAX_PER_GROUP,
  type ProjectView,
} from "../src/projects.js";

/** Structural balance check (same shape as usage.test.ts). */
function isBalanced(html: string): boolean {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith("</")) {
      if (stack.pop() !== m[1]) return false;
    } else if (!m[0].endsWith("/>") && !["br", "hr"].includes(m[1]!)) {
      stack.push(m[1]!);
    }
  }
  return stack.length === 0;
}

const NOW = new Date("2026-07-04T12:00:00.000Z");

describe("topicDeepLink", () => {
  it("strips the leading -100 from the chat id", () => {
    // ⚠️ format needs live verification in a private forum supergroup.
    expect(topicDeepLink(-1001234567890, 42)).toBe("https://t.me/c/1234567890/42");
    expect(topicDeepLink("-1009999", 7)).toBe("https://t.me/c/9999/7");
  });

  it("leaves a non -100 id untouched", () => {
    expect(topicDeepLink(-500, 3)).toBe("https://t.me/c/-500/3");
  });
});

describe("shortenHome", () => {
  it("replaces the home prefix with ~", () => {
    expect(shortenHome("/home/kiril/proj", "/home/kiril")).toBe("~/proj");
    expect(shortenHome("/home/kiril", "/home/kiril")).toBe("~");
    expect(shortenHome("/opt/other", "/home/kiril")).toBe("/opt/other");
  });
});

describe("renderProjectsRich", () => {
  it("renders projects, cwds, grouped session lines, balanced", () => {
    const projects: ProjectView[] = [
      {
        name: "alpha",
        cwd: "/home/kiril/alpha",
        newKey: 1,
        running: [{ title: "live one", threadId: 100 }],
        disconnected: [{ title: "sleeping one", threadId: 101 }],
        resumable: [{ title: "old one", attachKey: 2, date: "2026-07-03 18:00" }],
      },
    ];
    const html = renderProjectsRich(projects, NOW);
    expect(html).toContain("<h3>📁 Projects</h3>");
    expect(html).toContain("updated 2026-07-04 12:00 UTC");
    expect(html).toContain("<h4>alpha</h4>");
    expect(html).toContain("<code>/home/kiril/alpha</code>");
    expect(html).toContain("🟢 <b>live one</b>");
    expect(html).toContain("🔌 <b>sleeping one</b>");
    expect(html).toContain("💤 <b>old one</b> · 2026-07-03 18:00");
    expect(isBalanced(html)).toBe(true);
  });

  it("shows a 'no sessions' note for an empty project", () => {
    const html = renderProjectsRich(
      [{ name: "empty", cwd: "/x", newKey: 1, running: [], disconnected: [], resumable: [] }],
      NOW,
    );
    expect(html).toContain("<h4>empty</h4>");
    expect(html).toContain("no sessions");
    expect(isBalanced(html)).toBe(true);
  });

  it("caps each state group and adds an '…and N more' line", () => {
    const many = Array.from({ length: PROJECTS_MAX_PER_GROUP + 3 }, (_, i) => ({
      title: `s${i}`,
      attachKey: i + 1,
    }));
    const html = renderProjectsRich(
      [{ name: "big", cwd: "/x", newKey: 99, running: [], disconnected: [], resumable: many }],
      NOW,
    );
    // Only the first N are shown; the rest collapse.
    expect(html).toContain("💤 <b>s0</b>");
    expect(html).toContain(`💤 <b>s${PROJECTS_MAX_PER_GROUP - 1}</b>`);
    expect(html).not.toContain(`<b>s${PROJECTS_MAX_PER_GROUP}</b>`);
    expect(html).toContain("…and 3 more");
    expect(isBalanced(html)).toBe(true);
  });

  it("escapes interpolated names and cwds", () => {
    const html = renderProjectsRich(
      [
        {
          name: "a<b>",
          cwd: "/p&q",
          newKey: 1,
          running: [{ title: "x<y>", threadId: 1 }],
          disconnected: [],
          resumable: [],
        },
      ],
      NOW,
    );
    expect(html).toContain("a&lt;b&gt;");
    expect(html).toContain("/p&amp;q");
    expect(html).toContain("x&lt;y&gt;");
  });

  it("renders an empty overview", () => {
    const html = renderProjectsRich([], NOW);
    expect(html).toContain("No projects yet");
    expect(isBalanced(html)).toBe(true);
  });
});

describe("buildProjectsKeyboard", () => {
  it("emits a proj:new button, url buttons for topics, proj:att for resumable", () => {
    const projects: ProjectView[] = [
      {
        name: "alpha",
        cwd: "/home/kiril/alpha",
        newKey: 5,
        running: [{ title: "live", threadId: 100 }],
        disconnected: [{ title: "sleep", threadId: 101 }],
        resumable: [{ title: "old", attachKey: 6 }],
      },
    ];
    const kb = buildProjectsKeyboard(projects, -1001234567890);
    const flat = kb.inline_keyboard.map((r) => r[0]!);

    const newBtn = flat[0]!;
    expect("callback_data" in newBtn && newBtn.callback_data).toBe("proj:new:5");
    expect(newBtn.text).toContain("➕ alpha");

    // Running + disconnected → url deep-links to their topics.
    const runBtn = flat.find((b) => b.text.startsWith("🟢"))!;
    expect("url" in runBtn && runBtn.url).toBe("https://t.me/c/1234567890/100");
    const discBtn = flat.find((b) => b.text.startsWith("🔌"))!;
    expect("url" in discBtn && discBtn.url).toBe("https://t.me/c/1234567890/101");

    // Resumable → callback attach button.
    const attBtn = flat.find((b) => b.text.startsWith("💤"))!;
    expect("callback_data" in attBtn && attBtn.callback_data).toBe("proj:att:6");
  });

  it("caps buttons per state group at PROJECTS_MAX_PER_GROUP", () => {
    const many = Array.from({ length: PROJECTS_MAX_PER_GROUP + 4 }, (_, i) => ({
      title: `s${i}`,
      attachKey: i + 1,
    }));
    const kb = buildProjectsKeyboard(
      [{ name: "big", cwd: "/x", newKey: 1, running: [], disconnected: [], resumable: many }],
      -100999,
    );
    const attachButtons = kb.inline_keyboard
      .map((r) => r[0]!)
      .filter((b) => "callback_data" in b && b.callback_data.startsWith("proj:att:"));
    expect(attachButtons).toHaveLength(PROJECTS_MAX_PER_GROUP);
  });
});
