function cleanAiText(value, maximum = 1_000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, Math.max(0, maximum));
}

function summarizeEmbedsForAi(embeds, { maxEmbeds = 4, maxFields = 12, maxChars = 2_000 } = {}) {
  const summaries = [];
  let remaining = Math.max(0, maxChars);
  const take = (value, maximum) => {
    if (remaining <= 0) return "";
    const text = cleanAiText(value, Math.min(maximum, remaining));
    remaining -= text.length;
    return text;
  };

  for (const embed of [...(embeds ?? [])].slice(0, Math.max(0, maxEmbeds))) {
    if (remaining <= 0) break;
    const summary = {};
    const author = take(embed?.author?.name, 160);
    const title = take(embed?.title, 256);
    const description = take(embed?.description, 1_000);
    const footer = take(embed?.footer?.text, 256);
    if (author) summary.author = author;
    if (title) summary.title = title;
    if (description) summary.description = description;
    const fields = [];
    for (const field of [...(embed?.fields ?? [])].slice(0, Math.max(0, maxFields))) {
      const name = take(field?.name, 256);
      const value = take(field?.value, 700);
      if (name || value) fields.push({ name, value });
      if (remaining <= 0) break;
    }
    if (fields.length) summary.fields = fields;
    if (footer) summary.footer = footer;
    if (Object.keys(summary).length) summaries.push(summary);
  }
  return summaries;
}

function extractMessageTextForAi(message, { maxChars = 5_000, maxEmbeds = 8, maxFields = 20 } = {}) {
  const content = cleanAiText(message?.cleanContent || message?.content, maxChars);
  const embeds = summarizeEmbedsForAi(message?.embeds, { maxEmbeds, maxFields, maxChars: Math.max(0, maxChars - content.length) });
  const embedText = embeds.flatMap((embed) => [
    embed.author,
    embed.title,
    embed.description,
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
    embed.footer,
  ]).filter(Boolean).join("\n");
  return [content, embedText].filter(Boolean).join("\n").slice(0, maxChars);
}

export { cleanAiText, extractMessageTextForAi, summarizeEmbedsForAi };
