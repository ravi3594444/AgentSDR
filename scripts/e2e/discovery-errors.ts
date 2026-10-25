/** Source recovery with fake clients and a local disposable database. */
import {mock} from "bun:test";
import {join} from "node:path";
if(!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL??""))throw new Error("Use a local disposable DATABASE_URL");
process.env.GMAPS_SCRAPER_URL="http://scraper.discovery-errors.test";process.env.GEOCODER_URL="off";
let scraperCalls=0;
globalThis.fetch=Object.assign(async()=>{scraperCalls++;throw new TypeError("getaddrinfo EAI_AGAIN scraper.discovery-errors.test");},{preconnect:()=>{}});
const root=join(import.meta.dir,"../..");
const {db}=await import("@/lib/db");const {organizations,users,members}=await import("@/lib/auth/schema");const {assistantJobs}=await import("@/lib/assistant/schema");
const {runInOrganization,currentOrganizationId}=await import("@/lib/tenancy/scope");const {createThread,addMessage}=await import("@/lib/assistant/threads.server");
const apify=await import("@/lib/apify/apify.server");
mock.module(join(root,"src/lib/apify/apify.server.ts"),()=>({...apify,apifyReadiness:async()=>({usable:false,slotsFull:false,reason:"fixture: no approved fallback"}),startTrackedRun:async()=>({started:false,slotsFull:false,budget:false,reason:"fixture: provider refused before starting"})}));
const web=await import("@/lib/discovery/webDiscovery.server");let webAvailable=true,webStarts=0;
mock.module(join(root,"src/lib/discovery/webDiscovery.server.ts"),()=>({...web,startWebDiscovery:async(...args:Parameters<typeof web.startWebDiscovery>)=>{if(!webAvailable)throw new web.WebDiscoveryUnavailableError("fixture: no web source configured");webStarts++;const [criteria,context,options]=args;const [job]=await db.insert(assistantJobs).values({organizationId:currentOrganizationId(),kind:"web_discovery",stage:"queued",threadId:context.threadId,payload:{criteria,...options}}).returning();return {jobId:job!.id,audienceId:"fixture-web-list",phrase:criteria.customers,searchProvider:"tinyfish"};}}));
const {runDiscoveryStep}=await import("@/lib/discovery/discovery.server");
const stamp=crypto.randomUUID();const [org]=await db.insert(organizations).values({name:`Source errors ${stamp}`,slug:`source-errors-${stamp}`}).returning();const [owner]=await db.insert(users).values({name:"Owner",email:`source-errors-${stamp}@test.invalid`,emailVerified:true}).returning();await db.insert(members).values({organizationId:org!.id,userId:owner!.id,role:"owner"});
let failures=0,passes=0;function check(label:string,ok:boolean){console.log(`${ok?"PASS":"FAIL"}  ${label}`);if(ok)passes++;else failures++;}
await runInOrganization(org!.id,async()=>{
 const thread=await createThread(owner!.id);const request=await addMessage({threadId:thread.id,role:"user",content:"Find business owners and contact them",createdBy:owner!.id});
 async function job(){const [row]=await db.insert(assistantJobs).values({organizationId:org!.id,threadId:thread.id,kind:"discovery",stage:"queued",payload:{criteria:{what:"business owners",where:"Pune",maxResults:5,language:"en"},phrase:"business owners in Pune",target:"maps",provider:"apify",apifyFallbackTried:true,requestMessageId:request.id},progress:{source:"Google Maps through Apify"}}).returning();return row!;}
 const original=await job();const outcome=await runDiscoveryStep(original,async()=>{});
 check("Apify refusal and scraper DNS failure hand off instead of ending research",outcome.next==="done"&&outcome.result.notSearched===true&&typeof outcome.result.handedToJobId==="string");
 check("the attempted provider is correctly recorded",outcome.progress?.provider==="scraper"&&outcome.progress?.source==="Google Maps through the built-in scraper");
 const {eq}=await import("drizzle-orm");const [child]=outcome.next==="done"?await db.select().from(assistantJobs).where(eq(assistantJobs.id,String(outcome.result.handedToJobId))):[];
 check("the handoff preserves the request, target and place",child?.payload.requestMessageId===request.id&&(child?.payload.criteria as {customers?:string;where?:string}).customers==="business owners"&&(child?.payload.criteria as {where?:string}).where==="Pune");
 const again=await runDiscoveryStep(original,async()=>{});check("retry reuses the existing handoff",again.next==="done"&&outcome.next==="done"&&again.result.handedToJobId===outcome.result.handedToJobId&&webStarts===1);
 webAvailable=false;const blocked=await runDiscoveryStep(await job(),async()=>{});check("no available fallback reports both actual blockers",blocked.next==="failed"&&/EAI_AGAIN/.test(blocked.error)&&/no web source configured/.test(blocked.error));
 check("a failed builtin scrape is not labelled Apify",blocked.progress?.source==="Google Maps through the built-in scraper");check("only the expected fixture scraper attempts occurred",scraperCalls===3);
});
console.log(`${passes} passed, ${failures} failed. Discovery error checks complete.`);process.exit(failures?1:0);
