import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Api, ApiError, type EventStatus } from "../src/api";
import { loadConfig, saveConfig, clearConfig, normalizeUrl } from "../src/config";
import { parsePayload } from "../src/program";
import { safe, statusTable, endpointTable } from "../src/output";
import { waitForEvent, tailAttempts } from "../src/poll";
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "hooka-test-")); vi.stubEnv("HOOKA_API_KEY", ""); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });
const config = { baseUrl: "https://example.com", apiKey: "private-key" };
describe("configuration", () => {
  it("saves, loads and deletes config, restricting Unix permissions", async () => {
    const path = join(dir, "config.json"); await saveConfig(config, path); expect(await loadConfig(path)).toEqual(config);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await clearConfig(path); await clearConfig(path); await expect(loadConfig(path)).rejects.toThrow("hooka login");
  });
  it("replaces the old key atomically", async () => { const path = join(dir,"config"); await saveConfig(config,path); await saveConfig({...config,apiKey:"new"},path); expect(JSON.parse(await readFile(path,"utf8")).apiKey).toBe("new"); });
  it("handles corrupt config", async () => { const path=join(dir,"config"); await writeFile(path,"{"); await expect(loadConfig(path)).rejects.toThrow("invalid JSON"); });
  it("supports environment-only auth", async () => { vi.stubEnv("HOOKA_API_KEY","env-key");vi.stubEnv("HOOKA_BASE_URL","https://example.com/");expect(await loadConfig(join(dir,"missing"))).toEqual({...config,apiKey:"env-key"}); });
  it.each(["http://example.com", "https://u:p@example.com", "https://example.com?token=x", "ftp://localhost", "broken"])("rejects unsafe base URL %s", value => expect(()=>normalizeUrl(value)).toThrow());
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000", "https://example.com"])("accepts %s", value=>expect(normalizeUrl(value+"/")).toBe(value));
});
describe("HTTP client", () => {
  it("uses bearer authentication and disables redirects",async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({application:{id:"a"}})); const api=new Api(config,undefined,fetcher);
    await api.me(); expect(fetcher).toHaveBeenCalledWith("https://example.com/api/v1/me",expect.objectContaining({redirect:"error",headers:expect.objectContaining({Authorization:"Bearer private-key"})}));
  });
  it("preserves payload and idempotency fields",async()=>{
    const fetcher=vi.fn().mockResolvedValue(Response.json({id:"e"}));await new Api(config,undefined,fetcher).send("cus_123","order.shipped",null,"key");expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({customerId:"cus_123",type:"order.shipped",payload:null,idempotencyKey:"key"});
  });
  it.each([401,403])("explains HTTP %s without echoing keys",async status=>{const api=new Api(config,undefined,vi.fn().mockResolvedValue(new Response("",{status})));await expect(api.me()).rejects.toThrow("hooka login");});
  it("reports API validation errors",async()=>{const api=new Api(config,undefined,vi.fn().mockResolvedValue(Response.json({error:"invalid type"},{status:400})));await expect(api.me()).rejects.toThrow("invalid type");});
  it("handles network failures and invalid JSON",async()=>{
    await expect(new Api(config,undefined,vi.fn().mockRejectedValue(new TypeError("network"))).me()).rejects.toThrow("network connection");
    await expect(new Api(config,undefined,vi.fn().mockResolvedValue(new Response("html"))).me()).rejects.toBeInstanceOf(ApiError);
  });
  it("aborts timed-out requests",async()=>{
    vi.useFakeTimers(); const fetcher=vi.fn((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("aborted")))));
    const promise=new Api(config,undefined,fetcher as never).me();const assertion=expect(promise).rejects.toThrow("timed out");await vi.advanceTimersByTimeAsync(15000);await assertion;
  });
});
describe("payload and terminal safety",()=>{
  it.each(["null","{}",'"你好"',"[1,2]", "false"])("parses JSON %s",raw=>expect(parsePayload(raw)).toEqual(JSON.parse(raw)));
  it("explains malformed JSON",()=>expect(()=>parsePayload("{bad")).toThrow("Malformed JSON"));
  it("removes escape sequences and line controls from server data",()=>expect(safe("\x1b[31mred\x1b[0m\n\x07")).toBe("red  "));
  it("handles empty endpoint and delivery sets",()=>{expect(endpointTable([])).toContain("No endpoints");expect(statusTable({deliveries:[]} as unknown as EventStatus)).toContain("No matching");});
});
describe("polling",()=>{
  const status=(state:string,generation=2)=>({event:{id:"e"},generation,deliveries:[{id:"d",status:state,attempts:state==="PENDING"?0:1,endpoint:{url:"https://example.com"},lastAttempt:null}]} as EventStatus);
  it("pins the requested generation and stops only at terminal status",async()=>{
    vi.useFakeTimers();const api={status:vi.fn().mockResolvedValueOnce(status("PENDING")).mockResolvedValueOnce(status("DELIVERED"))};const update=vi.fn();
    const pending=waitForEvent(api,"e",{signal:new AbortController().signal,interval:1500,timeout:0,generation:2,update});await vi.advanceTimersByTimeAsync(1500);expect((await pending).deliveries[0].status).toBe("DELIVERED");expect(api.status.mock.calls).toEqual([["e",2],["e",2]]);expect(update).toHaveBeenCalledTimes(2);
  });
  it("times out without claiming delivery stopped",async()=>{vi.useFakeTimers();const api={status:vi.fn().mockResolvedValue(status("PENDING"))};const promise=waitForEvent(api,"e",{signal:new AbortController().signal,interval:1000,timeout:1000,update:()=>{}});const assertion=expect(promise).rejects.toThrow("continues on the server");await vi.advanceTimersByTimeAsync(1000);await assertion;});
  it("cancels waits without another poll",async()=>{vi.useFakeTimers();const controller=new AbortController();const api={status:vi.fn().mockResolvedValue(status("PENDING"))};const promise=waitForEvent(api,"e",{signal:controller.signal,interval:1500,timeout:0,update:()=>controller.abort()});await expect(promise).rejects.toThrow("Cancelled");expect(api.status).toHaveBeenCalledOnce();});
  it("drains cursor pages and deduplicates attempt IDs",async()=>{const attempt={id:"a"};const api={attempts:vi.fn().mockResolvedValueOnce({attempts:[attempt],nextCursor:"one",hasMore:true}).mockResolvedValueOnce({attempts:[attempt,{id:"b"}],nextCursor:"two",hasMore:false})};const print=vi.fn();
    api.attempts.mockReset().mockResolvedValueOnce({attempts:[attempt],nextCursor:"one",hasMore:true}).mockResolvedValueOnce({attempts:[attempt,{id:"b"}],nextCursor:"two",hasMore:false});
    await tailAttempts(api,{signal:new AbortController().signal,interval:1500,endpoint:"ep",once:true,print});expect(print).toHaveBeenCalledTimes(2);expect(api.attempts.mock.calls).toEqual([["ep",null],["ep","one"]]);
  });
});

