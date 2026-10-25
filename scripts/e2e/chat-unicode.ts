/** Live lead-review save regression. Local disposable DB; no providers. */
export {};
if(!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL??""))throw new Error("Use a local disposable DATABASE_URL");
const {and,eq}=await import("drizzle-orm");
const {db}=await import("@/lib/db");
const {organizations,users,members}=await import("@/lib/auth/schema");
const {assistantMessages}=await import("@/lib/assistant/schema");
const {runInOrganization,inOrg}=await import("@/lib/tenancy/scope");
const {addMessage,createThread,updateMessage}=await import("@/lib/assistant/threads.server");
const {cleanString}=await import("@/lib/grid/sanitize");
const stamp=crypto.randomUUID();const [org]=await db.insert(organizations).values({name:`Unicode ${stamp}`,slug:`unicode-${stamp}`}).returning();
const [owner]=await db.insert(users).values({name:"Owner",email:`unicode-${stamp}@test.invalid`,emailVerified:true}).returning();
await db.insert(members).values({organizationId:org!.id,userId:owner!.id,role:"owner"});
let failures=0,passes=0,messageId="";
function check(label:string,ok:boolean){console.log(`${ok?"PASS":"FAIL"}  ${label}`);if(ok)passes++;else failures++;}
const invalid="A business owner 👇🏻".slice(0,-1);
await runInOrganization(org!.id,async()=>{
 const thread=await createThread(owner!.id);const message=await addMessage({threadId:thread.id,role:"tool",tool:"review_leads",content:"Reviewing leads…",status:"running"});messageId=message.id;
 let refused=false;try{await db.update(assistantMessages).set({toolResult:{summary:invalid}}).where(and(inOrg(assistantMessages),eq(assistantMessages.id,message.id)));}catch(error){const e=error as Error&{cause?:{code?:string}};refused=e.cause?.code==="22P02"||/surrogate|json/i.test(String(e.cause??e));}
 check("control: PostgreSQL rejects the half-emoji JSON from the live log",refused);
 let updateError:unknown;try{await updateMessage(message.id,{status:"ok",content:invalid,toolResult:{summary:invalid,data:{valid:"Verified owner 🦉 👇🏻",nested:[{["bad\ud800key"]:"bad\u0000value\udc00"}]}}});}catch(error){updateError=error;}
 check("the completed tool message saves instead of HTTP 500",!updateError);
 const [saved]=await db.select().from(assistantMessages).where(and(inOrg(assistantMessages),eq(assistantMessages.id,message.id)));
 check("the tool is complete instead of permanently running",saved?.status==="ok");
 check("content and JSON summary are safe",saved?.content===cleanString(invalid)&&saved?.toolResult?.summary===cleanString(invalid));
 const data=saved?.toolResult?.data as {valid?:string;nested?:unknown[]}|undefined;
 check("valid emoji survive; nested keys and values are cleaned",data?.valid==="Verified owner 🦉 👇🏻"&&JSON.stringify(data.nested)===JSON.stringify([{"bad�key":"badvalue�"}]));
 if(!updateError){await updateMessage(message.id,{status:"error"});const [again]=await db.select().from(assistantMessages).where(and(inOrg(assistantMessages),eq(assistantMessages.id,message.id)));check("status-only update retains the existing result",again?.status==="error"&&JSON.stringify(again.toolResult)===JSON.stringify(saved?.toolResult));}else check("status-only update retains the existing result",false);
});
const [other]=await db.insert(organizations).values({name:`Other ${stamp}`,slug:`unicode-other-${stamp}`}).returning();
await runInOrganization(other!.id,()=>updateMessage(messageId,{status:"ok",content:"foreign overwrite"}));
await runInOrganization(org!.id,async()=>{const [saved]=await db.select().from(assistantMessages).where(and(inOrg(assistantMessages),eq(assistantMessages.id,messageId)));check("another organization cannot overwrite the message",saved?.status==="error"&&saved?.content!=="foreign overwrite");});
console.log(`${passes} passed, ${failures} failed. Chat Unicode checks complete.`);process.exit(failures?1:0);
