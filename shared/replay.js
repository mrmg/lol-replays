export function cameraName(cameraId, index = 0) {
  const match = /^cam(\d+)$/.exec(cameraId);
  return `Camera ${match ? Number(match[1]) + 1 : index + 1}`;
}

export function renderAngles(container, clips, selected = "all") {
  const angles = clips.map((clip, index) => ({
    id: clip.cameraId,
    name: cameraName(clip.cameraId, index),
    status: clip.ready && clip.url ? "" : clip.pending ? "Saving" : "Unavailable",
  }));
  if (angles.length > 1) {
    angles.unshift({ id: "all", name: "All cameras", status: angles.some((a) => !a.status) ? "" : "Waiting" });
  }

  angles.forEach((angle, index) => {
    let button = container.children[index];
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      container.append(button);
    }
    const label = angle.status ? `${angle.name} · ${angle.status}` : angle.name;
    if (button.textContent !== label) button.textContent = label;
    button.dataset.cameraId = angle.id;
    button.disabled = Boolean(angle.status);
    const active = angle.id === selected || (selected === "all" && angles.length === 1);
    button.setAttribute("aria-pressed", String(active && !button.disabled));
  });
  while (container.children.length > angles.length) container.lastElementChild.remove();
}

// Keep quick angle changes and repeated jog taps in the order the host made them.
let lastRequest = Promise.resolve();
export function sendReplay(command, buzzedAt) {
  const request = lastRequest.then(async () => {
    const res = await fetch("/api/host/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...command, buzzedAt }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Replay unavailable.");
  });
  lastRequest = request.catch(() => {});
  return request;
}
