// Pull the bulb's cord on the login page to reveal the hidden admin login.
(() => {
  const rig = document.getElementById("bulb-rig");
  const cord = document.getElementById("pull-cord");
  const knob = document.getElementById("pull-knob");
  const panel = document.getElementById("admin-win");
  const REST = 70;
  const PULL = 75; // How far the cord must be pulled, in pixels.
  let startY = 0;

  function reveal() {
    rig.classList.add("lit");
    document.body.classList.add("lit-page");
    panel.hidden = false;
    document.getElementById("admin-email").focus();
  }
  function hide() {
    rig.classList.remove("lit");
    document.body.classList.remove("lit-page");
    panel.hidden = true;
  }

  knob.addEventListener("pointerdown", (event) => {
    startY = event.clientY;
    rig.classList.add("dragging");
    knob.setPointerCapture(event.pointerId);
  });
  knob.addEventListener("pointermove", (event) => {
    if (!rig.classList.contains("dragging")) return;
    cord.style.height = `${REST + Math.min(150, Math.max(0, event.clientY - startY))}px`;
  });
  function release(event) {
    if (!rig.classList.contains("dragging")) return;
    rig.classList.remove("dragging");
    const pulled = event.clientY - startY;
    cord.style.height = "";
    if (pulled >= PULL) {
      if (panel.hidden) reveal(); else hide();
    }
  }
  knob.addEventListener("pointerup", release);
  knob.addEventListener("pointercancel", release);
  // Keyboard users can pull it with Enter or Space.
  knob.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (panel.hidden) reveal(); else hide();
    }
  });
  panel.querySelector(".light.red").addEventListener("click", hide);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) hide();
  });

  const form = document.getElementById("admin-form");
  const message = document.getElementById("admin-message");
  const codeField = document.getElementById("admin-code-field");
  const button = document.getElementById("admin-button");
  let step = "email";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    button.disabled = true;
    const body = new FormData(form);
    try {
      const response = await fetch(step === "email" ? "/backstage/code" : "/backstage/verify", { method: "POST", body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (step === "email") {
        step = "code";
        codeField.hidden = false;
        button.textContent = "Enter";
        message.textContent = "If this address has admin access, a code is on its way.";
        if (result.shown_code) document.getElementById("admin-code").value = result.shown_code;
        document.getElementById("admin-code").focus();
      } else {
        location.href = result.next;
      }
    } catch (error) {
      message.textContent = error.message || "Something went wrong.";
    }
    button.disabled = false;
  });
})();
