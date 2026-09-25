import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProgram } from "../src/program";
import { saveConfig } from "../src/config";
let server: Server;
let dir: string;
let baseUrl: string;
let requests: { path: string; body: unknown; auth?: string }[];
const endpoint={id:"ep",url:"https://example.com/hook",circuitState:"CLOSED",successRate:100,eventTypes:["*"]};
beforeEach(async()=>{
  dir=await mkdtemp(join(tmpdir(),"hooka-commands-"));requests=[];
  vi.stubEnv("HOOKA_CONFIG",join(dir,"config.json"));vi.stubEnv("HOOKA_API_KEY","");vi.stubEnv("HOOKA_BASE_URL","");
  server=createServer(async(req,res)=>{
    let text="";for await(const chunk of req)text+=chunk;
    requests.push({path:req.url!,body:text?JSON.parse(text):undefined,auth:req.headers.authorization});
    res.setHeader("content-type","application/json");
    if(req.headers.authorization!=="Bearer key") {res.statusCode=401;res.end('{"error":"Invalid API key"}');return;}
    let data:unknown;
    if(req.url==="/api/v1/me") data={application:{id:"app",name:"Test app"}};
    else if(req.url==="/api/v1/applications/app/customers") data=req.method==="POST"?{id:"cus_123",externalId:"demo",name:"Demo customer"}:[{id:"cus_123",externalId:"demo",name:"Demo customer"}];
    else if(req.url==="/api/v1/endpoints") data=req.method==="POST"?{endpoint:{...endpoint,secret:"test-signing-secret"}}:{endpoints:[endpoint]};
    else if(req.url==="/api/v1/events") data={id:"ev",type:"order.shipped",idempotencyKey:"idem"};
    else if(req.url==="/api/v1/events/ev/replay") data={eventId:"ev",generation:3,queued:1};
    else if(req.url?.startsWith("/api/v1/events/ev")) data={event:{id:"ev"},generation:3,deliveries:[{id:"d",endpoint,status:"DELIVERED",attempts:1,lastAttempt:{status:"SUCCESS",httpStatusCode:200}}]};
    else if(req.url?.startsWith("/api/v1/attempts")) data={attempts:[{id:"attempt",createdAt:"2026-09-15T00:00:00Z",event:{type:"order.shipped"},endpoint,status:"SUCCESS",httpStatusCode:200,durationMs:30}],nextCursor:"cursor",hasMore:false};
    else {res.statusCode=404;data={error:"not found"};}
    res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  await saveConfig({baseUrl,apiKey:"key"});
});
afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));vi.unstubAllEnvs();await rm(dir,{recursive:true,force:true});});
async function run(args:string[], answers:string[]=[]){const log=vi.fn();const ask=vi.fn(async()=>answers.shift()||"");await createProgram({log,ask}).exitOverride().parseAsync(args,{from:"user"});return {output:log.mock.calls.map(c=>c[0]).join("\n"),ask};}
it("validates interactive login before saving and supports whoami/logout",async()=>{
  expect((await run(["login"],[baseUrl,"key"])).output).toContain("Logged in to Test app");
  expect(JSON.parse(await readFile(join(dir,"config.json"),"utf8"))).toEqual({baseUrl,apiKey:"key"});
  expect((await run(["whoami"])).output).toContain("Application: app");await run(["logout"]);await expect(run(["whoami"])).rejects.toThrow("hooka login");
});
it("failed login preserves the saved configuration",async()=>{await expect(run(["login"],[baseUrl,"wrong"])).rejects.toThrow("Invalid or expired");expect(JSON.parse(await readFile(join(dir,"config.json"),"utf8")).apiKey).toBe("key");});
it("lists and creates customers",async()=>{
  expect((await run(["customers","list"])).output).toContain("cus_123");
  expect((await run(["customers","add","--external-id","demo","--name","Demo customer"])).output).toContain("cus_123");
  expect(requests.at(-1)?.body).toEqual({externalId:"demo",name:"Demo customer"});
});
it("lists and adds endpoints including the signing secret",async()=>{
  expect((await run(["endpoints","list"])).output).toContain("CLOSED");
  expect((await run(["endpoints","add",endpoint.url,"--customer-id","cus_123","--events","order.shipped, order.cancelled"])).output).toContain("test-signing-secret");
  expect(requests.at(-1)?.body).toEqual({url:endpoint.url,eventTypes:["order.shipped","order.cancelled"],customerId:"cus_123"});
});
it("sends inline JSON and waits for the original generation",async()=>{const result=await run(["send","--customer-id","cus_123","--type","order.shipped","--payload",'{"orderId":123}']);expect(result.output).toContain("DELIVERED");expect(requests[0].body).toEqual({customerId:"cus_123",type:"order.shipped",payload:{orderId:123}});expect(requests[1].path).toBe("/api/v1/events/ev?generation=0");});
it("reads payload files and can skip waiting",async()=>{const file=join(dir,"payload.json");await writeFile(file,'{"unicode":"你好"}');await run(["send","--customer-id","cus_123","--type","test","--payload-file",file,"--no-wait","--idempotency-key","mine"]);expect(requests).toHaveLength(1);expect(requests[0].body).toEqual({customerId:"cus_123",type:"test",payload:{unicode:"你好"},idempotencyKey:"mine"});});
it("prompts for omitted event fields",async()=>{const result=await run(["send","--customer-id","cus_123","--no-wait"],["test","null"]);expect(result.ask).toHaveBeenCalledTimes(2);expect(requests[0].body).toEqual({customerId:"cus_123",type:"test",payload:null});});
it("replay follows exactly the returned generation",async()=>{expect((await run(["replay","ev"])).output).toContain("generation 3");expect(requests.map(r=>r.path)).toEqual(["/api/v1/events/ev/replay","/api/v1/events/ev?generation=3"]);});
it("tails a filtered page with HTTP status and duration",async()=>{const result=await run(["tail","--endpoint","ep","--once"]);expect(result.output).toContain("HTTP 200");expect(result.output).toContain("30ms");expect(requests[0].path).toBe("/api/v1/attempts?endpoint=ep");});
it.each(["succeed","fail","hang","flaky"])("prints fake receiver %s without a network call",async mode=>{expect((await run(["fake-receiver",mode])).output).toBe(`${baseUrl}/api/fake-receiver/${mode}`);expect(requests).toHaveLength(0);});
it.each([
  ["send","--customer-id","cus_123","--type","test","--payload","{}","--payload-file","x"],
  ["send","--customer-id","cus_123","--type","bad space","--payload","{}"],
  ["send","--customer-id","cus_123","--type","test","--payload","broken"],
  ["send","--customer-id","cus_123","--type","test","--payload-file","missing.json"],
  ["endpoints","add",endpoint.url,"--customer-id","cus_123","--events",","],
  ["fake-receiver","unknown"],
])("rejects invalid input before a network request %#",async(...args)=>{await expect(run(args)).rejects.toThrow();expect(requests).toHaveLength(0);});
it("documents every command with examples",()=>{const program=createProgram();for(const command of program.commands){if(command.name()==="help")continue;expect(command.description()).not.toBe("");expect(command.helpInformation()).toContain("Usage:");}});
