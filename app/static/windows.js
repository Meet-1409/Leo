// Mac-style windows on the landing page: close with a genie effect, minimize to the dock,
// expand, and drag by the title bar.
(() => {
  const desk = document.getElementById("desk");
  const dock = document.getElementById("dock");
  const reopen = document.getElementById("reopen");
  if (!desk) return;
  const SLICES = 48;
  const DURATION = 620;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const closed = [];
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  // Cuts a copy of the window into slices. Lower slices reach the target first, and each
  // narrows as it falls, which pours the window down into one point.
  function genie(win, target, done) {
    const box = win.getBoundingClientRect();
    if (reducedMotion || !box.width) { done(); return; }
    const layer = document.createElement("div");
    layer.className = "genie-layer";
    Object.assign(layer.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    const sliceHeight = box.height / SLICES;
    const slices = [];
    for (let i = 0; i < SLICES; i += 1) {
      const slice = document.createElement("div");
      Object.assign(slice.style, { top: `${i * sliceHeight}px`, width: `${box.width}px`, height: `${sliceHeight + 0.6}px` });
      const copy = win.cloneNode(true);
      copy.removeAttribute("data-win");
      Object.assign(copy.style, { position: "absolute", top: `${-i * sliceHeight}px`, left: 0, width: `${box.width}px`, height: `${box.height}px`, margin: 0, animation: "none", transform: "none" });
      slice.appendChild(copy);
      layer.appendChild(slice);
      slices.push(slice);
    }
    document.body.appendChild(layer);
    win.style.visibility = "hidden";
    const targetX = target.x - box.left - box.width / 2;
    const targetY = target.y - box.top;
    const start = performance.now();
    const progress = (v, t) => {
      const lead = 0.5 * (1 - v); // Lower parts of the window leave first.
      return ease(clamp01((t - lead) / (1 - lead)));
    };
    function frame(now) {
      const t = clamp01((now - start) / DURATION);
      slices.forEach((slice, i) => {
        // Each slice runs from its own top to the next slice's top, so no gaps can open.
        const v = i / SLICES;
        const nextV = (i + 1) / SLICES;
        const p = progress(v, t);
        const top = (targetY - i * sliceHeight) * p;
        const bottom = (i + 1) * sliceHeight + (targetY - (i + 1) * sliceHeight) * progress(nextV, t) - i * sliceHeight;
        const scaleY = Math.max((bottom - top) / sliceHeight, 0.001);
        // Width narrows along the funnel, as the slice nears the target.
        const scaleX = Math.max(0.03, (1 - p) ** 1.25);
        slice.style.transformOrigin = "center top";
        slice.style.transform = `translate(${targetX * p}px,${top}px) scale(${scaleX},${scaleY})`;
        slice.style.opacity = t > 0.92 ? String((1 - t) / 0.08) : "1";
      });
      if (t < 1) requestAnimationFrame(frame);
      else { layer.remove(); done(); }
    }
    requestAnimationFrame(frame);
  }

  function dockPoint() {
    const box = dock.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  function updateReopen() {
    reopen.hidden = closed.length === 0;
  }

  function closeWin(win) {
    genie(win, dockPoint(), () => {
      win.style.visibility = "";
      win.hidden = true;
      closed.push(win);
      updateReopen();
    });
  }

  function minimizeWin(win) {
    const name = win.querySelector(".win-title").textContent;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = name;
    chip.setAttribute("aria-label", `Restore ${name}`);
    dock.insertBefore(chip, reopen);
    const box = chip.getBoundingClientRect();
    genie(win, { x: box.left + box.width / 2, y: box.top + box.height / 2 }, () => {
      win.style.visibility = "";
      win.hidden = true;
    });
    chip.addEventListener("click", () => {
      chip.remove();
      win.hidden = false;
    });
  }

  reopen.addEventListener("click", () => {
    closed.splice(0).forEach((win) => { win.hidden = false; });
    updateReopen();
  });

  desk.addEventListener("click", (event) => {
    const light = event.target.closest(".light");
    if (!light) return;
    const win = light.closest("[data-win]");
    if (light.classList.contains("red")) closeWin(win);
    else if (light.classList.contains("yellow")) minimizeWin(win);
    else {
      win.style.transform = "";
      win.classList.toggle("zoomed");
    }
  });

  // Drag by the title bar. The window stays where it is dropped.
  desk.querySelectorAll(".win-bar").forEach((bar) => {
    bar.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".light")) return;
      const win = bar.closest("[data-win]");
      const startX = event.clientX - (Number(win.dataset.x) || 0);
      const startY = event.clientY - (Number(win.dataset.y) || 0);
      win.classList.add("lifted");
      bar.setPointerCapture(event.pointerId);
      const move = (e) => {
        win.dataset.x = e.clientX - startX;
        win.dataset.y = e.clientY - startY;
        win.style.transform = `translate(${win.dataset.x}px,${win.dataset.y}px)`;
      };
      const up = () => {
        win.classList.remove("lifted");
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
  });
})();
