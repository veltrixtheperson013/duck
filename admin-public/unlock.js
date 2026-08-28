const root = location.pathname.replace(/\/+$/, "");
const form = document.querySelector("[data-unlock]");
const errorBox = document.querySelector("[data-error]");

async function request(path, options = {}) {
  const response = await fetch(`${root}${path}`, { ...options, credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Verification failed (${response.status}).`);
  return body;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  errorBox.textContent = "";
  try {
    const session = await request("/api/session");
    await request("/api/session", { method: "POST", headers: { "Content-Type": "application/json", "X-Duck-CSRF": session.loginCsrf || "" }, body: JSON.stringify({ token: String(new FormData(form).get("token") || "").trim() }) });
    form.reset();
    location.reload();
  } catch (error) {
    errorBox.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
