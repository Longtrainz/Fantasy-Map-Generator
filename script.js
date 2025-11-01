// === Константы ===
const FMG_ORIGIN = "https://longtrainz.github.io"; // откуда идут postMessage
const CHAN = "fmg-bridge-v1";

// === DOM ===
const iframe = document.getElementById("fmgFrame");
const btnExport = document.getElementById("btnExport");
const btnDownload = document.getElementById("btnDownload");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("exportPreview");
const svgInfoEl = document.getElementById("svgInfo");

// === состояние ===
let bridgeReady = false;     // пришёл ли bridge-ready
let helloOk = false;         // пришёл ли hello-ok
let waitingExport = false;   // пользователь нажал "Export", но ещё нет hello-ok
let currentReqId = null;
let chunks = [];
let chunksTotal = 0;
let lastSvgText = null;

// === утилита: лог в консоль и в статус ===
function setStatus(text) {
  console.log("[host]", text);
  statusEl.textContent = text;
}

// === отправить hello в iframe ===
function sendHello() {
  if (!iframe.contentWindow) {
    setStatus("iframe ещё не готов");
    return;
  }
  const reqId = "hello-" + Date.now();
  const msg = {
    chan: CHAN,
    type: "hello",
    requestId: reqId
  };
  iframe.contentWindow.postMessage(msg, FMG_ORIGIN);
  setStatus("шлю hello…");
}

// === отправить экспорт ===
function sendExport() {
  if (!helloOk) {
    // если по какой-то причине hello ещё не ок — запомним и пошлём позже
    waitingExport = true;
    setStatus("жду hello-ok, потом сделаю экспорт…");
    sendHello(); // на всякий случай
    return;
  }

  const reqId = "exp-" + Date.now();
  currentReqId = reqId;
  chunks = [];
  chunksTotal = 0;

  const msg = {
    chan: CHAN,
    type: "export",
    format: "svg",
    requestId: reqId
  };

  iframe.contentWindow.postMessage(msg, FMG_ORIGIN);
  setStatus("запрашиваю экспорт…");
  btnExport.disabled = true;
  btnDownload.disabled = true;
}

// === получить постMessage от iframe ===
window.addEventListener("message", (ev) => {
  // фильтр по origin
  if (ev.origin !== FMG_ORIGIN) {
    return;
  }

  const data = ev.data;
  if (!data || data.chan !== CHAN) {
    return;
  }

  // чисто для отладки
  console.log("[host] msg from FMG:", data);

  switch (data.type) {
    case "bridge-ready": {
      bridgeReady = true;
      setStatus("iframe готов (bridge-ready)");
      // можем сразу послать hello, чтобы не ждать клика
      sendHello();
      break;
    }

    case "hello-ok": {
      helloOk = true;
      setStatus("связь установлена (hello-ok)");
      if (waitingExport) {
        waitingExport = false;
        // чуть-чуть подождём, чтобы iframe точно всё проглотил
        setTimeout(sendExport, 100);
      }
      break;
    }

    case "export-start": {
      if (data.requestId !== currentReqId) return;
      chunks = new Array(data.total).fill("");
      chunksTotal = data.total;
      setStatus(`получаю SVG… (0/${data.total})`);
      break;
    }

    case "export-chunk": {
      if (data.requestId !== currentReqId) return;
      chunks[data.index] = data.data;
      const readyCount = chunks.filter(Boolean).length;
      setStatus(`получаю SVG… (${readyCount}/${chunksTotal})`);
      break;
    }

    case "export-end": {
      if (data.requestId !== currentReqId) return;
      const rawSvg = chunks.join("");
      const fixedSvg = fixSvgBounds(rawSvg); // ← вот тут лечим обрезание
      lastSvgText = fixedSvg;
      showPreview(fixedSvg);
      setStatus(`ГОТОВО  svgLen=${fixedSvg.length}`);
      btnExport.disabled = false;
      btnDownload.disabled = false;
      svgInfoEl.textContent = `OK: svgLen=${fixedSvg.length}`;
      break;
    }

    case "error": {
      setStatus("ошибка от iframe: " + data.error);
      btnExport.disabled = false;
      break;
    }
  }
});

// === кнопка "Export map" в хедере ===
btnExport.addEventListener("click", () => {
  if (!bridgeReady) {
    setStatus("iframe ещё не сказал bridge-ready");
    return;
  }
  sendExport();
});

// === кнопка "Скачать SVG" ===
btnDownload.addEventListener("click", () => {
  if (!lastSvgText) return;
  const blob = new Blob([lastSvgText], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "map.svg";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// === показать превью ===
function showPreview(svgText) {
  previewEl.innerHTML = ""; // очистим
  // вставляем как DOM, не как <img>, чтобы было видно целиком
  const wrapper = document.createElement("div");
  wrapper.innerHTML = svgText;
  const svgEl = wrapper.firstElementChild;
  svgEl.style.maxWidth = "100%";
  svgEl.style.height = "auto";
  previewEl.appendChild(svgEl);
}

// === самое главное: расширяем viewBox/width/height, чтобы не обрезало ===
function fixSvgBounds(svgText, padding = 140) {
  // парсим
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;

  // базовые размеры
  let w = parseFloat(svg.getAttribute("width")) || 1200;
  let h = parseFloat(svg.getAttribute("height")) || 800;

  // увеличиваем физические размеры (это не строго обязательно, но полезно)
  svg.setAttribute("width", String(w + padding * 2));
  svg.setAttribute("height", String(h + padding * 2));

  // теперь viewBox
  const vb = svg.getAttribute("viewBox");
  if (vb) {
    const parts = vb.split(/\s+/).map(Number);
    const minX = parts[0] - padding;
    const minY = parts[1] - padding;
    const vbW = parts[2] + padding * 2;
    const vbH = parts[3] + padding * 2;
    svg.setAttribute("viewBox", `${minX} ${minY} ${vbW} ${vbH}`);
  } else {
    // если FMG не дал viewBox — создадим сами
    const minX = -padding;
    const minY = -padding;
    const vbW = w + padding * 2;
    const vbH = h + padding * 2;
    svg.setAttribute("viewBox", `${minX} ${minY} ${vbW} ${vbH}`);
  }

  // сериализуем обратно
  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}
