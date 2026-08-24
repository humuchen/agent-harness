const http = require("http");
function streamRun(body, token = "test123") {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {"content-type":"application/json","authorization":"Bearer "+token};
    const req = http.request({ host:"127.0.0.1", port:4173, path:"/api/v1/run", method:"POST", headers }, r => {
      if (r.statusCode !== 200) { let b=""; r.on("data",d=>b+=d); r.on("end",()=>reject(new Error("HTTP "+r.statusCode+": " + b.slice(0,200)))); return; }
      const events = []; let buf = "";
      r.on("data", chunk => { buf += chunk.toString(); let i; while ((i = buf.indexOf("\n\n")) !== -1) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); for (const line of frame.split("\n").filter(l => l.startsWith("data:"))) { const val = line.slice(5).replace(/^ /,""); if (!val.trim()) continue; try { events.push(JSON.parse(val)); } catch {} } } });
      r.on("end", () => { if (buf.trim()) { for (const line of buf.split("\n").filter(l => l.startsWith("data:"))) { const val = line.slice(5).replace(/^ /,""); if (!val.trim()) continue; try { events.push(JSON.parse(val)); } catch {} } } resolve(events); });
    });
    req.on("error", reject); req.write(data); req.end();
  });
}
async function run() {
  const sid = "plan-e2e-"+Date.now();
  const userInput = "帮我做一份青岛医美市场调研提纲";
  console.log("[1] submit plan propose...");
  const events = await streamRun({ chatSessionId:sid, prompt:userInput, interactionMode:"plan", planPhase:"propose", sessionId:sid });
  console.log("[1] events=" + events.length + ", types=" + events.map(e=>e.type).join(","));
  const hasDone = events.some(e=>e.type==="_done");
  console.log("  [1] PROPOSE_DONE", hasDone ? "OK" : "FAIL");
  const tasks = [`【计划任务 t1】竞品梳理\n步骤：1. 收集5家机构\n预期产出：竞品对比表`, `【计划任务 t2】用户画像\n步骤：1. 抽样调研30人\n预期产出：画像报告`];
  console.log("[2] dispatch task t1...");
  const t2a = Date.now();
  const e2a = await streamRun({ chatSessionId:sid, prompt:tasks[0], sessionId:sid });
  console.log("  done=" + e2a.some(e=>e.type==="_done") + " " + (Date.now()-t2a) + "ms");
  console.log("[3] dispatch task t2...");
  const t3a = Date.now();
  const e2b = await streamRun({ chatSessionId:sid, prompt:tasks[1], sessionId:sid });
  console.log("  done=" + e2b.some(e=>e.type==="_done") + " " + (Date.now()-t3a) + "ms");
  const all = hasDone && e2a.some(e=>e.type==="_done") && e2b.some(e=>e.type==="_done");
  console.log("RESULT:", all ? "ALL PASS OK" : "SOME FAIL FAIL");
  process.exit(all ? 0 : 1);
}
run().catch(e => { console.error("FATAL:", e.message); process.exit(2); });
