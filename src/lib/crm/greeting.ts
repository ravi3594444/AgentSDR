/**
 * Whether an inbound message is only a greeting or an acknowledgement
 * ("Hey", "Hi Ravi", "ok thanks", "theek hai"): the person replied, and
 * nothing more can be read into it. Decided in code, before the AI's
 * classification is accepted, so a model that calls "Hey" interested never
 * gets to mark the lead that way. English, Hindi and Hinglish.
 */

const WORDS = new Set([
  "hey", "heyy", "heyyy", "hi", "hii", "hiii", "hello", "helo", "hellooo", "yo", "hola", "namaste", "namaskar", "hy",
  "good", "morning", "afternoon", "evening", "night",
  "ok", "okay", "okk", "okkk", "k", "kk", "fine", "cool", "nice", "great", "sure", "noted", "alright", "right",
  "thanks", "thank", "you", "thx", "ty", "thankyou", "dhanyavad", "shukriya",
  "yes", "yeah", "yep", "yup", "ya", "haan", "han", "ji", "hmm", "hmmm", "hm", "oh", "ohh", "ah", "achha", "acha", "accha", "theek", "thik", "hai", "h", "sahi",
  "that", "thats", "that's", "is", "it", "so", "very", "too", "really", "good", "sounds",
]);

/** Words of address that say nothing about intent. */
const FILLER = new Set(["there", "sir", "madam", "maam", "ma'am", "bro", "ji", "bhai", "dear", "team", "ravi", "friend", "boss", "man", "dude", "guys", "all"]);

const GREETING_WORDS = new Set(["hey", "heyy", "heyyy", "hi", "hii", "hiii", "hello", "helo", "hellooo", "yo", "hola", "namaste", "namaskar", "hy", "morning", "afternoon", "evening"]);

/**
 * Only an acknowledgement ("ok", "thanks", "noted", 👍), not a greeting: the
 * one kind of message that needs no answer once we have answered them. A
 * greeting ("Hey", "Hi bro") always gets a reply.
 */
export function isAcknowledgementOnly(text: string): boolean {
  if (!isBareGreeting(text)) return false;
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
  return !words.some((word) => GREETING_WORDS.has(word));
}

export function isBareGreeting(text: string): boolean {
  const cleaned = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .trim();
  if (!cleaned) return true; // only emoji or punctuation
  if (/\?/.test(text) || /\d{5,}/.test(text)) return false;
  const words = cleaned.split(/\s+/).filter((word) => !FILLER.has(word));
  if (words.length === 0) return true;
  if (words.length > 5) return false;
  return words.every((word) => WORDS.has(word));
}
