const thanks = document.querySelector("[data-billing-thanks]");
if (new URLSearchParams(location.search).has("thanks")) {
  thanks?.removeAttribute("hidden");
  thanks?.scrollIntoView({ behavior: "smooth", block: "center" });
}

const plusCard = document.querySelector("[data-plus-card]");
if (plusCard) {
  fetch("/api/site-config")
    .then((response) => response.ok ? response.json() : Promise.reject(new Error("Site configuration unavailable")))
    .then(({ plusEnabled }) => {
      if (!plusEnabled) return;
      plusCard.querySelectorAll("[data-plus-action]").forEach((element) => { element.hidden = false; });
      const unavailable = plusCard.querySelector("[data-plus-unavailable]");
      if (unavailable) unavailable.hidden = true;
    })
    .catch(() => {});
}

for (const button of document.querySelectorAll("[data-donate-amount]")) {
  button.addEventListener("click", async () => {
    const status = document.querySelector("[data-donation-status]");
    const buttons = [...document.querySelectorAll("[data-donate-amount]")];
    buttons.forEach((item) => { item.disabled = true; });
    if (status) status.textContent = "Opening secure checkout…";
    try {
      const response = await fetch("/donate/checkout", { method: "POST", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ amount: Number(button.dataset.donateAmount) }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Checkout is unavailable right now.");
      const destination = new URL(body.url);
      if (destination.protocol !== "https:") throw new Error("Checkout returned an unsafe destination.");
      location.assign(destination.toString());
    } catch (error) {
      if (status) status.textContent = error.message;
      buttons.forEach((item) => { item.disabled = false; });
    }
  });
}
