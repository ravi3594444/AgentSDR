import { describe, expect, test } from "bun:test";
import { cleanBusinessName, listingUrl, mapsSearchPhrase, parseMapsCsv, rankEmails } from "./mapsResults";

const HEADER = "input_id,link,title,category,address,website,phone,review_count,review_rating,place_id,cid,status,complete_address,emails";

function row(values: string[]): string {
  return values.map((value) => `"${value.replace(/"/g, "\"\"")}"`).join(",");
}

const CSV = [
  HEADER,
  row(["1", "https://maps.google.com/?cid=1", "Smile Dental", "Dentist", "MG Road, Pune", "https://www.smiledental.in/", "098765 43210", "120", "4.6", "place-1", "1", "", JSON.stringify({ city: "Pune", country: "IN" }), "info@smiledental.in, noreply@smiledental.in,dr@gmail.com"]),
  row(["1", "https://maps.google.com/?cid=1", "Smile Dental", "Dentist", "MG Road, Pune", "", "", "", "", "place-1", "1", "", "", ""]),
  row(["1", "https://maps.google.com/?cid=2", "Closed Clinic", "Dentist", "", "https://facebook.com/closed", "12", "", "", "place-2", "2", "Permanently closed", "", ""]),
  row(["1", "", "", "Dentist", "", "", "", "", "", "place-3", "", "", "", ""]),
].join("\n");

describe("parseMapsCsv", () => {
  const places = parseMapsCsv(CSV, "IN");

  test("one record per place, nameless rows and repeats dropped", () => {
    expect(places.map((p) => p.name)).toEqual(["Smile Dental", "Closed Clinic"]);
  });

  test("normalizes the phone with the listing's country and keeps the Maps link as source", () => {
    const smile = places[0]!;
    expect(smile.phone).toBe("+919876543210");
    expect(smile.mapsUrl).toBe("https://maps.google.com/?cid=1");
    expect(smile.city).toBe("Pune");
    expect(smile.country).toBe("IN");
    expect(smile.rating).toBe(4.6);
    expect(smile.reviewCount).toBe(120);
  });

  test("keeps only usable emails and the business's own website", () => {
    const smile = places[0]!;
    expect(smile.emails).toEqual(["info@smiledental.in", "dr@gmail.com"]);
    expect(smile.domain).toBe("smiledental.in");
    const closed = places[1]!;
    expect(closed.website).toBeNull();
    expect(closed.closed).toBe("Permanently closed");
    expect(closed.phone).toBeNull();
    expect(closed.phoneProblem).toContain("too short");
  });
});

describe("helpers", () => {
  test("rankEmails puts the website's own domain first", () => {
    expect(rankEmails(["dr@gmail.com", "info@smiledental.in"], "smiledental.in")).toEqual(["info@smiledental.in", "dr@gmail.com"]);
  });

  test("mapsSearchPhrase joins what and where", () => {
    expect(mapsSearchPhrase("  dental   clinics ", "Pune,  India")).toBe("dental clinics in Pune, India");
    expect(mapsSearchPhrase("bakeries", null)).toBe("bakeries");
  });
});

describe("fast-mode rows", () => {
  test("listingUrl builds the Maps link from data_id's CID when link, cid and place_id are empty", () => {
    expect(listingUrl({ link: "", cid: "", place_id: "", data_id: "0x3bc2bed749aa32ff:0x33c07af4f2fcd209" })).toBe(`https://maps.google.com/?cid=${BigInt("0x33c07af4f2fcd209").toString()}`);
    expect(listingUrl({ link: "https://maps.google.com/?cid=1" })).toBe("https://maps.google.com/?cid=1");
    expect(listingUrl({ cid: "42" })).toBe("https://maps.google.com/?cid=42");
    expect(listingUrl({})).toBeNull();
  });

  test("cleanBusinessName drops keywords appended to listings", () => {
    expect(cleanBusinessName("Go-Best Dentist | Dr Mokashi Dental clinic | Baner")).toBe("Go-Best Dentist");
    expect(cleanBusinessName("Dental Clinic in Baner| Enamel Craft Dental")).toBe("Dental Clinic in Baner");
    expect(cleanBusinessName("No Decay Dental Clinic - Dr. Geeta Kolte Ursal - Dental Clinic in Aundh Pune")).toBe("No Decay Dental Clinic");
    expect(cleanBusinessName("Dr. Varsha's Dental Cosmetic and Implant Centre-Dentist in Balewadi/RCT Specialist/Child Oral Care")).toBe("Dr. Varsha's Dental Cosmetic and Implant Centre");
    expect(cleanBusinessName("Go-Best Dentist")).toBe("Go-Best Dentist");
    expect(cleanBusinessName("A | B")).toBe("A | B");
  });
});
