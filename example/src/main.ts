import { RoomClient } from "room-server/client";
import type { PersistenceLevel } from "room-server/types";

// ── DOM refs ──────────────────────────────────────────────────────────────────

const dot = document.getElementById("dot")!;
const statusText = document.getElementById("status-text")!;
const connectPanel = document.getElementById("connect-panel")!;
const appEl = document.getElementById("app")!;
const disconnectBtn = document.getElementById("disconnect-btn") as HTMLButtonElement;

const inpHost = document.getElementById("inp-host") as HTMLInputElement;
const inpKey = document.getElementById("inp-key") as HTMLInputElement;
const inpRoom = document.getElementById("inp-room") as HTMLInputElement;
const inpPersistence = document.getElementById("inp-persistence") as HTMLSelectElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;

const kvList = document.getElementById("kv-list")!;
const kvCount = document.getElementById("kv-count")!;
const inpKvKey = document.getElementById("inp-kv-key") as HTMLInputElement;
const inpKvValue = document.getElementById("inp-kv-value") as HTMLInputElement;
const btnKvSet = document.getElementById("btn-kv-set") as HTMLButtonElement;

const messages = document.getElementById("messages")!;
const inpChat = document.getElementById("inp-chat") as HTMLInputElement;
const btnSend = document.getElementById("btn-send") as HTMLButtonElement;

// ── State ─────────────────────────────────────────────────────────────────────

let client: RoomClient | null = null;
// Local mirror of all KV entries so we can re-render efficiently.
const kvStore = new Map<string, unknown>();
// Nickname derived from random id so users can tell messages apart.
const nick = "user-" + Math.random().toString(36).slice(2, 6);

// ── Connect ───────────────────────────────────────────────────────────────────

connectBtn.addEventListener("click", async () => {
  const host = inpHost.value.trim();
  const apiKey = inpKey.value.trim();
  const roomId = inpRoom.value.trim();
  const persistence = inpPersistence.value as PersistenceLevel;

  if (!host || !apiKey || !roomId) return;

  connectBtn.disabled = true;
  statusText.textContent = "connecting…";

  client = new RoomClient({ host, roomId, config: { apiKey, persistence } });

  // Subscribe to all keys, including our own writes — the server is the single
  // source of truth; we never write to the local mirror directly.
  client.subscribePrefix("", (e) => {
    if (e.type === "delete") {
      kvStore.delete(e.key);
    } else {
      kvStore.set(e.key, e.value);
    }
    renderKv();
    flashEntry(e.key);
  }, { includeSelf: true });

  // Receive chat messages.
  client.onBroadcast("chat", (data) => {
    const d = data as { nick: string; text: string };
    appendMessage(d.nick, d.text, false);
  });

  try {
    await client.ready();
  } catch {
    setStatus(false);
    statusText.textContent = "connection failed";
    connectBtn.disabled = false;
    return;
  }

  // Hydrate local mirror from server.
  const existing = await client.list("");
  for (const [k, v] of Object.entries(existing.entries)) kvStore.set(k, v);
  renderKv();

  setStatus(true);
  statusText.textContent = `${apiKey} / ${roomId} · ${persistence}`;
  connectPanel.style.display = "none";
  appEl.classList.add("visible");
  disconnectBtn.style.display = "";
  connectBtn.disabled = false;
});

disconnectBtn.addEventListener("click", () => {
  client?.disconnect();
  client = null;
  kvStore.clear();
  renderKv();
  messages.innerHTML = "";
  setStatus(false);
  statusText.textContent = "disconnected";
  appEl.classList.remove("visible");
  connectPanel.style.display = "";
  disconnectBtn.style.display = "none";
});

// ── KV operations ─────────────────────────────────────────────────────────────

btnKvSet.addEventListener("click", () => kvSet());
inpKvValue.addEventListener("keydown", (e) => { if (e.key === "Enter") kvSet(); });

async function kvSet() {
  if (!client) return;
  const key = inpKvKey.value.trim();
  const raw = inpKvValue.value.trim();
  if (!key || !raw) return;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw; // treat as plain string
  }

  await client.set(key, value);
  inpKvKey.value = "";
  inpKvValue.value = "";
}

async function kvDelete(key: string) {
  if (!client) return;
  await client.delete(key);
}

// ── KV render ─────────────────────────────────────────────────────────────────

function renderKv() {
  kvCount.textContent = `${kvStore.size} entr${kvStore.size === 1 ? "y" : "ies"}`;

  if (kvStore.size === 0) {
    kvList.innerHTML = `<div class="empty-state">No entries yet. Set a key above.</div>`;
    return;
  }

  // Preserve existing DOM nodes when possible (only add/remove deltas).
  const existing = new Set(
    [...kvList.querySelectorAll<HTMLElement>(".kv-entry")].map(
      (el) => el.dataset["key"]!
    )
  );

  // Remove deleted keys.
  for (const key of existing) {
    if (!kvStore.has(key)) {
      kvList.querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
    }
  }

  // Add/update entries.
  for (const [key, value] of kvStore) {
    const valueStr =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    let el = kvList.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "kv-entry";
      el.dataset["key"] = key;
      el.innerHTML = `
        <span class="kv-key"></span>
        <span class="kv-value"></span>
        <button class="kv-del" title="Delete">×</button>
      `;
      el.querySelector(".kv-del")!.addEventListener("click", () => kvDelete(key));
      kvList.appendChild(el);
    }
    el.querySelector(".kv-key")!.textContent = key;
    el.querySelector(".kv-value")!.textContent = valueStr;
  }
}

function flashEntry(key: string) {
  const el = kvList.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
  if (!el) return;
  el.classList.add("changed");
  setTimeout(() => el.classList.remove("changed"), 800);
}

// ── Chat ──────────────────────────────────────────────────────────────────────

btnSend.addEventListener("click", sendChat);
inpChat.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

function sendChat() {
  if (!client) return;
  const text = inpChat.value.trim();
  if (!text) return;
  client.broadcast("chat", { nick, text });
  appendMessage(nick, text, true);
  inpChat.value = "";
}

function appendMessage(from: string, text: string, self: boolean) {
  const el = document.createElement("div");
  el.className = `msg${self ? " self" : ""}`;
  el.innerHTML = `
    <span class="msg-meta">${escHtml(from)}</span>
    <div class="msg-body">${escHtml(text)}</div>
  `;
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(connected: boolean) {
  dot.classList.toggle("connected", connected);
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
