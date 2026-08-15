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
