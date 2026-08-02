const legacyMode = /^[0-9a-f]{48}$/.test(
  new URLSearchParams(globalThis.location.search).get("legacy") ?? "",
);

if (!legacyMode) {
  await new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://appsforoffice.microsoft.com/lib/1/hosted/office.js";
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener("error", resolve, { once: true });
    document.head.append(script);
  });
}

await import("./taskpane.js");
