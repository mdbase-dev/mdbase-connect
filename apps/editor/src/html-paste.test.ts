import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { afterEach, describe, expect, it } from "vitest";
import { htmlPaste, htmlToMarkdown } from "./html-paste";

describe("htmlToMarkdown", () => {
  it("keeps a web page's structure", () => {
    expect(htmlToMarkdown(`<meta charset="utf-8"><h2>Release notes</h2><p>Read the <a href="https://example.com/docs">full docs</a> for <strong>important</strong> and <em>subtle</em> changes.</p>
      <ul><li>First point</li><li>Second with <code>code()</code><ul><li>Nested</li></ul></li></ul><ol start="3"><li>Step three</li><li>Step four</li></ol>
      <blockquote><p>Quoted wisdom</p><p>Second line</p></blockquote><pre><code class="language-js">let x = 1;\n  let y = 2;\n</code></pre><hr>
      <table><tr><th>Name</th><th>Value</th></tr><tr><td>a | b</td><td>1</td></tr></table><p><img src="https://example.com/pic.png" alt="A [picture]"></p>`))
      .toBe([
        "## Release notes",
        "Read the [full docs](https://example.com/docs) for **important** and *subtle* changes.",
        "- First point\n- Second with `code()`\n  - Nested",
        "3. Step three\n4. Step four",
        "> Quoted wisdom\n>\n> Second line",
        "```js\nlet x = 1;\n  let y = 2;\n```",
        "---",
        "| Name | Value |\n| --- | --- |\n| a \\| b | 1 |",
        "![A \\[picture\\]](https://example.com/pic.png)"
      ].join("\n\n"));
  });

  it("reads Google Docs styling and ignores its non-bold wrapper", () => {
    const docs = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400;white-space:pre-wrap;">Plain then </span><span style="font-weight:700;white-space:pre-wrap;">bold </span><span style="font-style:italic;white-space:pre-wrap;">and italic</span></p></b>`;
    expect(htmlToMarkdown(docs)).toBe("Plain then **bold** *and italic*");
  });

  it("leaves HTML without Markdown structure, and code editors' coloured runs, to the plain text", () => {
    expect(htmlToMarkdown("<p>Just</p><div>text</div>")).toBeNull();
    expect(htmlToMarkdown(`<div style="color: #d4d4d4;white-space: pre;"><div><span style="color: #569cd6;font-weight: bold;">const</span> a = 1;</div></div>`)).toBeNull();
  });

  it("keeps marks tight, escapes literal syntax and drops unlinkable targets", () => {
    expect(htmlToMarkdown("<p><b> spaced </b>end</p>")).toBe("**spaced** end");
    expect(htmlToMarkdown("<p><b>5 * 3</b> is [not] _emphasis_, snake_case stays</p>")).toBe("**5 \\* 3** is \\[not\\] \\_emphasis\\_, snake_case stays");
    expect(htmlToMarkdown("<p><em>1. not a list</em></p><p># not a heading</p>")).toBe("*1. not a list*\n\n\\# not a heading");
    expect(htmlToMarkdown(`<p><a href="javascript:alert(1)">x</a> <a href="https://e.com/a_(b)">wiki</a> <img src="data:image/png;base64,AAAA"></p>`))
      .toBe("x [wiki](<https://e.com/a_(b)>)");
    expect(htmlToMarkdown(`<p><a href="https://e.com/">https://e.com/</a></p>`)).toBe("https://e.com/");
  });

  describe("literal underscores and asterisks read back as typed", () => {
    const literals = ["__Bold__", "**Bold**", "_x_", "___x___", "*x*", "snake_case_word", "a__b", "1_000", "__init__.py", "_a_b_",
      "foo_bar_", "x_", "_", "__", "a_ _b", "(_x_)", "_x_.", "\"__x__\"", "*_x_*", "_*x*_", "é_x_é", "_ü_", "word__(x)__word"];

    /** The text a run of Markdown inlines displays, failing on anything but escapes. */
    function displayed(markdown: string, node: SyntaxNode): string {
      let text = "";
      let at = node.from;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "TableDelimiter") continue;
        expect(child.name, `${JSON.stringify(markdown)} parses ${child.name}`).toBe("Escape");
        text += markdown.slice(at, child.from) + markdown.slice(child.from + 1, child.to);
        at = child.to;
      }
      return text + markdown.slice(at, node.to);
    }

    function nodes(markdown: string, name: string): SyntaxNode[] {
      const found: SyntaxNode[] = [];
      markdownLanguage.parser.parse(markdown).iterate({ enter: (node) => { if (node.name === name) found.push(node.node); } });
      return found;
    }

    it.each(literals)("in a paragraph: %s", (literal) => {
      const markdown = htmlToMarkdown(`<p>${literal}</p><hr>`)!;
      expect(nodes(markdown, "Paragraph").map((paragraph) => displayed(markdown, paragraph))).toEqual([literal]);
    });

    it.each(literals)("in a table cell: %s", (literal) => {
      const markdown = htmlToMarkdown(`<table><tr><th>Markdown</th></tr><tr><td>${literal}</td></tr></table>`)!;
      const cells = nodes(markdown, "TableCell");
      expect(cells.map((cell) => displayed(markdown, cell))).toEqual(["Markdown", literal]);
    });

    it("beside real emphasis, which still parses", () => {
      const markdown = htmlToMarkdown("<p><b>bold</b>__x__ and <em>it</em>_y</p>")!;
      expect(markdown).toBe("**bold**\\_\\_x\\_\\_ and *it*\\_y");
      expect(nodes(markdown, "StrongEmphasis").length + nodes(markdown, "Emphasis").length).toBe(2);
    });
  });

  it("writes task lists and fences code that contains backticks", () => {
    expect(htmlToMarkdown(`<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>`)).toBe("- [x] done\n- [ ] todo");
    expect(htmlToMarkdown("<pre>a ``` b</pre>")).toBe("````\na ``` b\n````");
  });
});

describe("htmlPaste", () => {
  let view: EditorView | undefined;
  afterEach(() => view?.destroy());

  function paste(doc: string, at: number, html: string, text = "") {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({ doc, selection: { anchor: at }, extensions: [markdown({ base: markdownLanguage }), htmlPaste] })
    });
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: { types: ["text/html", "text/plain"], getData: (type: string) => type === "text/html" ? html : text } });
    view.contentDOM.dispatchEvent(event);
    return { handled: event.defaultPrevented, doc: view.state.doc.toString(), head: view.state.selection.main.head };
  }

  it("inserts inline Markdown at the caret and blocks on their own lines", () => {
    expect(paste("See  now", 4, `<a href="https://e.com/">this</a>`)).toEqual({ handled: true, doc: "See [this](https://e.com/) now", head: 26 });
    expect(paste("Before after", 7, "<h2>Title</h2><p>Body</p>").doc).toBe("Before \n\n## Title\n\nBody\n\nafter");
  });

  it("leaves pastes into code and plain HTML to the default paste", () => {
    expect(paste("```\ncode\n```", 6, "<b>bold</b>", "bold").doc).toBe("```\ncoboldde\n```");
    expect(paste("text ", 5, "<p>plain</p>", "plain").doc).toBe("text plain");
  });
});
