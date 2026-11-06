const form = document.querySelector("#invite-form");
const input = document.querySelector("#invite-code");
const submit = document.querySelector("#invite-submit");
const feedback = document.querySelector("#gate-feedback");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const inviteCode = input.value.trim();
  if (!inviteCode) {
    feedback.textContent = "请输入访问邀请码。";
    feedback.className = "gate-feedback error";
    input.focus();
    return;
  }

  submit.disabled = true;
  feedback.setAttribute("aria-busy", "true");
  feedback.className = "gate-feedback";
  feedback.textContent = "正在验证访问资格…";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteCode }),
    });
    if (response.ok) {
      feedback.className = "gate-feedback success";
      feedback.textContent = "验证通过，正在进入工作台…";
      window.location.replace("/");
      return;
    }
    if (response.status === 429) {
      feedback.textContent = "尝试次数过多，请稍后再试。";
    } else if (response.status === 401) {
      feedback.textContent = "邀请码无效，请核对后重试。";
      input.select();
    } else {
      feedback.textContent = "验证暂时不可用，请稍后重试。";
    }
    feedback.className = "gate-feedback error";
  } catch {
    feedback.className = "gate-feedback error";
    feedback.textContent = "无法连接本机认证服务；请确认 Tideflow 工作台仍在运行。";
  } finally {
    feedback.removeAttribute("aria-busy");
    submit.disabled = false;
  }
});
