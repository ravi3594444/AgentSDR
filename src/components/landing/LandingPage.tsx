"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowDown, ArrowRight, ArrowUpRight, Check, ChevronRight,
  FileText, Mail, MessageCircle, Search, ShieldCheck, Sparkles, Users,
} from "lucide-react";
import { RiLinkedinBoxLine, RiWhatsappLine } from "@remixicon/react";
import { Logo } from "@/components/brand/Logo";
import { useTheme } from "@/components/theme/ThemeProvider";
import { BRAND } from "@/lib/brand";
import SculptureHero from "./SculptureHero";
import "./landing.css";

const TOUR = [
  { label: "Find your people", icon: Search, prompt: "Find independent retailers in my area.", reply: "Start with the businesses that fit your offer. Review a focused list, with their contact details together.", heading: "A focused prospect list", rows: [["North & Co.", "Independent retail", "Website found"], ["The Corner Store", "Local business", "Email available"], ["Fieldwork Studio", "Design & retail", "Website found"]] },
  { label: "Shape the outreach", icon: FileText, prompt: "Help me introduce our service to this list.", reply: "Bring your offer, audience, and tone into one plan. Check the message and choose how replies are handled before you start.", heading: "Your outreach plan", rows: [["Audience", "Your selected leads", "Ready to review"], ["First message", "A personal introduction", "Draft"], ["Replies", "Review before sending", "Your choice"]] },
  { label: "Keep it moving", icon: MessageCircle, prompt: "Which conversations need me?", reply: "Routine questions can use your saved business information. Decisions, negotiations, and anything uncertain come back to you.", heading: "Conversations that need you", rows: [["North & Co.", "Asked about pricing", "Needs your input"], ["Fieldwork Studio", "Interested in a call", "Needs your input"], ["The Corner Store", "Requested information", "Draft ready"]] },
] as const;

const FAQ = [
  ["What do I need to get started?", "An account in your workspace, your business information, and a connected sending account for the channels you want to use. You can bring a contact list or ask the assistant to help find businesses. Available searches depend on your configured providers."],
  ["Does the assistant send messages straight away?", "No. It prepares an outreach plan for you to review. Outreach begins when you press Start. At that point, you choose whether replies run automatically or wait for your review."],
  ["Can I take over a conversation?", "Yes. You can review replies, answer questions that need your input, pause a run, or take over a conversation yourself. The assistant brings decisions and uncertain answers back to you."],
  ["Can I use more than one channel?", "The workspace supports email, LinkedIn, and WhatsApp through connected providers. Connect the channels you use, then manage your leads, outreach, and follow-ups from the same workspace."],
] as const;

function WorkspacePreview() {
  const [selected, setSelected] = useState(0);
  const step = TOUR[selected];
  return (
    <div className="lp-preview">
      <div className="lp-preview-top"><span className="lp-window-dots" aria-hidden="true"><i /><i /><i /></span><span>{BRAND.shortName} / Workspace</span><span className="lp-demo-label">Illustrative preview</span></div>
      <div className="lp-tour-tabs" role="tablist" aria-label="Explore the workspace">
        {TOUR.map(({ label, icon: Icon }, index) => (
          <button key={label} type="button" role="tab" id={`tour-tab-${index}`} aria-selected={selected === index} aria-controls="tour-panel" tabIndex={selected === index ? 0 : -1}
            onClick={() => setSelected(index)} onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % TOUR.length;
              else if (event.key === "ArrowLeft") next = (index + TOUR.length - 1) % TOUR.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = TOUR.length - 1;
              else return;
              event.preventDefault(); setSelected(next); document.getElementById(`tour-tab-${next}`)?.focus();
            }}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>
        ))}
      </div>
      <div id="tour-panel" role="tabpanel" aria-labelledby={`tour-tab-${selected}`} tabIndex={0} className="lp-tour-panel">
        <div className="lp-preview-conversation" key={selected}>
          <div className="lp-user-message">{step.prompt}<span>You</span></div>
          <div className="lp-agent-message"><span className="lp-agent-mark"><Sparkles size={17} aria-hidden="true" /></span><p>{step.reply}</p></div>
          <div className="lp-sample-table"><div className="lp-sample-heading"><Users size={15} aria-hidden="true" />{step.heading}<span>Sample data</span></div>
            {step.rows.map(([name, detail, status]) => <div className="lp-sample-row" key={name}><span className="lp-initial" aria-hidden="true">{name[0]}</span><span><strong>{name}</strong><small>{detail}</small></span><span className="lp-sample-status">{status}</span></div>)}
          </div>
        </div>
        <div className="lp-preview-bottom"><ShieldCheck size={14} aria-hidden="true" /><span>Your outreach starts with your approval.</span><span className="lp-preview-step">0{selected + 1} / 03</span></div>
      </div>
    </div>
  );
}

function ReplyPreview() {
  const [mode, setMode] = useState<"review" | "automatic">("review");
  return (
    <div className="lp-control-preview">
      <div className="lp-control-heading"><ShieldCheck size={22} aria-hidden="true" /><span>Made to work your way<small>Reply modes · illustrative preview</small></span></div>
      <div className="lp-mode-picker" role="group" aria-label="Preview reply modes">
        <button type="button" aria-pressed={mode === "review"} onClick={() => setMode("review")}>Review first</button>
        <button type="button" aria-pressed={mode === "automatic"} onClick={() => setMode("automatic")}>Automatic</button>
      </div>
      <div className="lp-mode-copy" aria-live="polite"><strong>{mode === "review" ? "The draft is ready. You decide." : "Routine replies, with clear boundaries."}</strong><p>{mode === "review" ? "Read the suggested response and approve it when you’re ready. Your voice, with a little less work." : "Replies use your saved information. Negotiations, promises, and questions without a supported answer come back to you."}</p></div>
      <div className="lp-control-note"><Check size={15} aria-hidden="true" />Pause, review, or take over at any time.</div>
    </div>
  );
}

export default function LandingPage() {
  const { resolved, setPreference } = useTheme();
  return (
    <main className="outreach-site" id="top">
      <a href="#workspace" className="lp-skip-link">Skip to product overview</a>
      <SculptureHero
        brand={<Logo iconClassName="size-8" />} brandHref="/"
        navLinks={[{ label: "Workspace", href: "#workspace" }, { label: "How it works", href: "#workflow" }, { label: "Questions", href: "#questions" }]}
        navCta={{ label: "Workspace ↗", href: "/assistant" }}
        eyebrow="Your next connection, thoughtfully made"
        headline={"Less busywork.\nMore connection."} headlineAccent="More connection."
        body="Find the right people. Start a better conversation. Turn your business knowledge into thoughtful outreach across email, LinkedIn, and WhatsApp."
        primaryCta={{ label: "Open your workspace", href: "/assistant" }}
        secondaryCta={{ label: "Explore the workflow", href: "#workspace" }}
        background="#ffffff" darkBackground="#000000" textColor={resolved === "dark" ? "#ffffff" : "#000000"}
        theme={resolved} onThemeChange={setPreference}
        headingFont="var(--font-sans)" bodyFont="var(--font-sans)" accentFont="var(--font-instrument-serif)" loadFonts={false}
        backdropText="connect" showCredit={false} particleDensity={0.75}
        height="max(780px, 100svh)" hint="Move across the form. See what connects." hintTouch="Touch to explore"
        className="lp-hero"
      />

      <div className="lp-channel-strip lp-wrap"><span>ONE WORKSPACE. THREE WAYS TO CONNECT.</span><div><span><Mail size={17} aria-hidden="true" />Email</span><span><RiLinkedinBoxLine size={18} aria-hidden="true" />LinkedIn</span><span><RiWhatsappLine size={18} aria-hidden="true" />WhatsApp</span></div><a href="#workspace" aria-label="Explore the workspace"><ArrowDown size={19} /></a></div>

      <section id="workspace" className="lp-section lp-workspace lp-wrap" aria-labelledby="workspace-heading">
        <div className="lp-section-intro"><div><p className="lp-eyebrow">01 / A little more clarity</p><h2 id="workspace-heading">Your outreach.<br /><em>All in one place.</em></h2></div><p>From the first prospect to the next follow-up. A calm workspace that keeps the details together and the next step clear.</p></div>
        <WorkspacePreview />
        <div className="lp-preview-caption"><span><span className="lp-status-dot" />Built around your business, your information, your voice.</span><Link href="/assistant">Explore your workspace <ArrowUpRight size={16} aria-hidden="true" /></Link></div>
      </section>

      <section id="workflow" className="lp-workflow" aria-labelledby="workflow-heading"><div className="lp-wrap lp-workflow-inner">
        <div className="lp-workflow-title"><p className="lp-eyebrow">02 / From intent to conversation</p><h2 id="workflow-heading">A simpler way<br />to <em>reach out.</em></h2><p>You bring the business.<br />Your assistant helps with the next steps.</p><Link href="/assistant" className="lp-text-link">Meet your assistant <ArrowUpRight size={18} aria-hidden="true" /></Link><div className="lp-orbit" aria-hidden="true"><span>22X</span><i /><i /><i /></div></div>
        <div className="lp-workflow-steps">
          <article><span className="lp-step-number">01</span><div><h3>Start with what makes you, you.</h3><p>Share your offer, ideal customers, and business details. Add a brochure, a price list, or a contact list. Give your assistant the context to work with.</p><div className="lp-file-tags"><span><FileText size={14} aria-hidden="true" />Business details</span><span><Users size={14} aria-hidden="true" />Your audience</span></div></div></article>
          <article><span className="lp-step-number">02</span><div><h3>Shape the plan. Make it yours.</h3><p>Review the leads and proposed outreach. Choose your channels and reply mode, then press Start when you’re ready.</p><span className="lp-workflow-note"><Check size={15} aria-hidden="true" />You approve the first move.</span></div></article>
          <article><span className="lp-step-number">03</span><div><h3>Give good conversations room.</h3><p>Keep leads, replies, and follow-ups together. Let the assistant handle supported routine answers and bring the important decisions back to you.</p><span className="lp-workflow-note"><MessageCircle size={15} aria-hidden="true" />A human hand, whenever it matters.</span></div></article>
        </div>
      </div></section>

      <section className="lp-section lp-control lp-wrap" aria-labelledby="control-heading"><div><p className="lp-eyebrow">03 / Your judgment stays in the loop</p><h2 id="control-heading">More support.<br /><em>Still your call.</em></h2><p className="lp-body-copy">A useful assistant knows when to ask. Choose how replies are handled, keep a view of what’s happening, and step in when a conversation needs you.</p><Link href="/assistant" className="lp-text-link">Work on your terms <ArrowUpRight size={18} aria-hidden="true" /></Link></div><ReplyPreview /></section>

      <section id="questions" className="lp-faq lp-section lp-wrap" aria-labelledby="questions-heading"><div><p className="lp-eyebrow">A few things, answered</p><h2 id="questions-heading">Good questions.<br /><em>Clear answers.</em></h2></div><div className="lp-faq-list">{FAQ.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></section>

      <section className="lp-closing" aria-labelledby="closing-heading"><div className="lp-wrap"><p className="lp-eyebrow">Make room for what comes next</p><h2 id="closing-heading">Your next<br /><em>connection awaits.</em></h2><Link href="/assistant" className="lp-closing-cta">Open your workspace <ArrowRight size={20} aria-hidden="true" /></Link><p>Better conversations begin with a little context.</p></div></section>

      <footer className="lp-footer lp-wrap"><Link href="/" aria-label={`${BRAND.name} home`}><Logo /></Link><span>Thoughtful outreach. By {BRAND.shortName}.</span><div><a href="#top">Back to top <ChevronRight size={14} aria-hidden="true" /></a><a href="https://guglielmogiannattasio.it" target="_blank" rel="noopener noreferrer" className="lp-template-credit">Sculpture by Guglielmo Giannattasio <ArrowUpRight size={12} aria-hidden="true" /></a></div></footer>
    </main>
  );
}
