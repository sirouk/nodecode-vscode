// Copy, cut, paste, select all and undo, inside the page this view frames.
//
// VS Code performs those keys itself: on Electron it stops the key from reaching
// the page and re-runs it as execCommand in the webview's own document. That works
// for a webview's document and for nothing inside it — and this view's document is
// a frame of its own, on the gateway's origin. So in here the keys arrived nowhere:
// ⌘C, ⌘V, ⌘X, ⌘A and ⌘Z did nothing at all, and the page's own copy buttons failed
// too, because VS Code refuses the clipboard API to any origin but a webview's own.
//
// The split that fixes it follows who is allowed what. Editing runs inside the page,
// where the selection and the caret are: execCommand there still writes the system
// clipboard. Only the clipboard API — reading what the operator copied elsewhere,
// and serving the page's copy buttons — crosses into the webview's document, which
// is the one origin VS Code grants it to. The two talk over postMessage, one frame
// up, and neither trusts the other's word about where it is.

export const BRIDGE_PATH = "/web/nodecode-bridge.js";

/** The name the page asks for, relative to /web/, so the page's own CSP admits it. */
export const BRIDGE_NAME = "nodecode-bridge.js";

/** The one tag the page proxy adds to the gateway's page. */
export function bridgeTag(): string {
  return `<script src="${BRIDGE_NAME}"></script>`;
}

/**
 * Runs inside the gateway's page. A page opened on its own is left alone: a
 * browser does all of this in a browser tab, and only the frame needs help.
 */
export const FRAME_SCRIPT = `(() => {
  if (window.parent === window) return;
  const host = window.parent;
  const waiting = new Map();
  let next = 1;

  function ask(kind, payload) {
    return new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      try {
        host.postMessage({ nodecode: "frame", id, kind, payload }, "*");
      } catch (error) {
        waiting.delete(id);
        resolve({});
        return;
      }
      setTimeout(() => { if (waiting.delete(id)) resolve({}); }, 4000);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== host) return;
    const data = event.data;
    if (!data || data.nodecode !== "host") return;
    const answer = waiting.get(data.id);
    if (!answer) return;
    waiting.delete(data.id);
    answer(data);
  });

  // Bytes a file was carried as, so a pasted screenshot arrives as the page's
  // own paste handler expects it: a File, in a paste event it can read.
  function bytes(text) {
    const raw = atob(text || "");
    const out = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) out[index] = raw.charCodeAt(index);
    return out;
  }

  function dropFiles(files) {
    const transfer = new DataTransfer();
    for (const file of files) {
      try {
        transfer.items.add(new File([bytes(file.base64)], file.name || "pasted", { type: file.type || "application/octet-stream" }));
      } catch (error) {
        return false;
      }
    }
    if (!transfer.files.length) return false;
    const target = document.activeElement || document.body;
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    return target.dispatchEvent(event);
  }

  // Where the caret is: an input or a box takes the text there, and the page's own
  // input listeners run, so the draft it draws stays what was typed.
  function insert(text) {
    const element = document.activeElement;
    if (!element || element === document.body || element === document.documentElement) return;
    if (document.execCommand("insertText", false, text)) return;
    if (typeof element.setRangeText !== "function") return;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    element.setRangeText(text, start, end, "end");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }

  function paste() {
    ask("read").then((answer) => {
      const taken = answer.files && answer.files.length ? dropFiles(answer.files) : false;
      if (!taken && answer.text) insert(answer.text);
    });
  }

  // The page's own copy buttons write the clipboard, which this origin is refused.
  try {
    const clipboard = navigator.clipboard;
    const writeText = (text) => ask("write", { text: String(text) }).then((answer) => {
      if (answer.ok) return;
      throw new Error("the clipboard refused the text");
    });
    if (clipboard && typeof clipboard.writeText === "function") {
      try { clipboard.writeText = writeText; } catch (error) { Object.getPrototypeOf(clipboard).writeText = writeText; }
    }
  } catch (error) {}

  const editing = { a: "selectAll", c: "copy", x: "cut" };
  window.addEventListener("keydown", (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (!meta || event.altKey || event.isComposing) return;
    const key = String(event.key || "").toLowerCase();
    if (key === "v") {
      event.preventDefault();
      paste();
      return;
    }
    const command = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" ? "redo" : editing[key];
    if (!command) return;
    event.preventDefault();
    document.execCommand(command);
  }, true);
})();
`;

/**
 * Runs in the webview's own document, which VS Code does grant the clipboard.
 * It answers the frame and only the frame: the origin it posted from, and the
 * window it posted with, both have to be the page this view framed.
 */
export function hostScript(origin: string): string {
  return `(() => {
  const page = document.getElementById("page");
  const origin = ${JSON.stringify(origin)};
  if (!page) return;

  function base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function read() {
    const answer = { ok: true, text: "", files: [] };
    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.read === "function") {
      for (const item of await clipboard.read()) {
        if (item.types.indexOf("text/plain") !== -1) answer.text = await (await item.getType("text/plain")).text();
        for (const type of item.types) {
          if (type.indexOf("image/") !== 0) continue;
          const blob = await item.getType(type);
          answer.files.push({ name: "pasted." + type.slice(6).replace("+xml", ""), type, base64: await base64(blob) });
        }
      }
      return answer;
    }
    answer.text = await clipboard.readText();
    return answer;
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || data.nodecode !== "frame") return;
    if (event.source !== page.contentWindow || event.origin !== origin) return;
    const answer = { nodecode: "host", id: data.id };
    try {
      if (data.kind === "write") {
        await navigator.clipboard.writeText(String((data.payload && data.payload.text) || ""));
        answer.ok = true;
      } else if (data.kind === "read") {
        const read_ = await read();
        answer.ok = true;
        answer.text = read_.text;
        answer.files = read_.files;
      } else {
        answer.ok = false;
      }
    } catch (error) {
      answer.ok = false;
    }
    page.contentWindow.postMessage(answer, origin);
  });
})();`;
}
