// The region picker: a frozen screenshot the person drags a rectangle over.
const shot = document.getElementById("shot");
const dim = document.getElementById("dim");
const box = document.getElementById("box");
const size = document.getElementById("size");
let start = null;

window.picker.onImage((dataUrl) => {
  shot.src = dataUrl;
});

function rectFrom(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

function draw(rect) {
  box.style.display = "block";
  dim.style.display = "none";
  box.style.left = `${rect.x}px`;
  box.style.top = `${rect.y}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
  size.style.display = "block";
  size.textContent = `${rect.width} × ${rect.height}`;
  size.style.left = `${rect.x}px`;
  size.style.top = `${Math.max(0, rect.y - 22)}px`;
}

document.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  start = { x: event.clientX, y: event.clientY };
  draw(rectFrom(start, start));
});
document.addEventListener("mousemove", (event) => {
  if (start) draw(rectFrom(start, { x: event.clientX, y: event.clientY }));
});
document.addEventListener("mouseup", (event) => {
  if (!start || event.button !== 0) return;
  const rect = rectFrom(start, { x: event.clientX, y: event.clientY });
  start = null;
  window.picker.done(rect.width >= 8 && rect.height >= 8 ? rect : null);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.picker.cancel();
});
