function cleanAiText(value, maximum = 1_000) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .slice(0, Math.max(0, maximum))
    .trim();
}

function summarizeEmbedsForAi(embeds, { maxEmbeds = 4, maxFields = 12, maxChars = 2_000 } = {}) {
  const summaries = [];
  let remaining = Math.max(0, maxChars);

  const take = (value, maximum) => {
    if (remaining <= 0 || !value) return "";
    const cleaned = cleanAiText(value, Math.min(maximum, remaining));
    remaining -= cleaned.length;
    return cleaned;
  };

  const list = Array.isArray(embeds) ? embeds : [];
  for (const embed of list.slice(0, Math.max(0, maxEmbeds))) {
    if (remaining <= 0 || !embed) break;

    const summary = {};
    const author = take(embed.author?.name, 160);
    const title = take(embed.title, 256);
    const description = take(embed.description, 1_000);

    if (author) summary.author = author;
    if (title) summary.title = title;
    if (description) summary.description = description;

    const rawFields = Array.isArray(embed.fields) ? embed.fields : [];
    const fields = [];
    for (const field of rawFields.slice(0, Math.max(0, maxFields))) {
      if (remaining <= 0) break;
      const name = take(field?.name, 256);
      const value = take(field?.value, 700);
      if (name || value) {
        fields.push({ name: name || undefined, value: value || undefined });
      }
    }

    if (fields.length) summary.fields = fields;

    const footer = take(embed.footer?.text, 256);
    if (footer) summary.footer = footer;

    if (Object.keys(summary).length) summaries.push(summary);
  }

  return summaries;
}

function extractMessageTextForAi(message, { maxChars = 5_000, maxEmbeds = 8, maxFields = 20 } = {}) {
  if (!message) return "";

  const content = cleanAiText(message.cleanContent || message.content, maxChars);
  const remainingChars = Math.max(0, maxChars - content.length);

  const embeds = summarizeEmbedsForAi(message.embeds, {
    maxEmbeds,
    maxFields,
    maxChars: remainingChars,
  });

  const embedLines = [];
  for (const embed of embeds) {
    if (embed.author) embedLines.push(embed.author);
    if (embed.title) embedLines.push(embed.title);
    if (embed.description) embedLines.push(embed.description);
    if (embed.fields) {
      for (const field of embed.fields) {
        if (field.name) embedLines.push(field.name);
        if (field.value) embedLines.push(field.value);
      }
    }
    if (embed.footer) embedLines.push(embed.footer);
  }

  const embedText = embedLines.join("\n");
  return [content, embedText].filter(Boolean).join("\n").slice(0, maxChars);
}

export { cleanAiText, extractMessageTextForAi, summarizeEmbedsForAi };