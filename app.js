const STORAGE_KEY = "cfi_field_tool_v2";

let model = null;
let products = null;
let arcsite = null;

let state = {
  job: { address:"", homeowner:"", date:"", notes:"" },
  answers: {},
  tags: [],
  suggestedSolutionIds: [],
  solutionNotes: {},
  flightPlans: {},
  promptsDone: {},
  perimeter: {
    mode: "rect",
    rect: { L: 0, W: 0, H: 0 },
    segments: [{len:10, turnDeg:90},{len:10, turnDeg:90},{len:10, turnDeg:90},{len:10, turnDeg:90}],
    points: []
  },
  dispo: {
    status: "unknown",
    followupDate: "",
    followupMethod: "call",
    notes: "",
    plan: ""
  }
};

const FIELD_PROMPTS = [
  { id:"pep", text:"PEP complete + safe access documented" },
  { id:"access_photo", text:"Photo: access/entry path (wide angle)" },
  { id:"baseline_outside", text:"Photo: hygrometer reading outside entrance (control)" },
  { id:"wide_angle_all", text:"Photos: wide-angle tour (counterclockwise, whole space)" },
  { id:"baseline_inside", text:"Photo: hygrometer reading inside space" },
  { id:"moisture_bottom", text:"Moisture meter reading at base of first corner (photo)" },
  { id:"moisture_mid", text:"Moisture meter reading mid-wall same spot (photo)" },
  { id:"moisture_top", text:"Moisture meter reading top of wall same vertical plane (photo)" },
  { id:"sketch_live", text:"All data + obstructions recorded on field-sketch as you go" },
  { id:"discharge_route", text:"Discharge path planned: topography + obstructions considered" }
];

function $(id){ return document.getElementById(id); }

function normalizeFlightPlan(fp) {
  // Migration helper: older versions stored flight plans as arrays.
  if (!fp) return { lines: [], notes: "" };
  if (Array.isArray(fp)) return { lines: fp, notes: "" };
  if (typeof fp === "object") {
    const lines = Array.isArray(fp.lines) ? fp.lines : [];
    const notes = typeof fp.notes === "string" ? fp.notes : "";
    return { lines, notes };
  }
  return { lines: [], notes: "" };
}

function getProductsForSolution(solutionKey, foundationType) {
  const t = (foundationType || "multiple").toLowerCase();
  const bySol = products?.solutionProducts?.[solutionKey] || {};
  if (t === "multiple") {
    const set = new Set();
    Object.values(bySol).forEach((arr) => (arr || []).forEach((x) => set.add(x)));
    return Array.from(set).sort();
  }
  return (bySol[t] || []).slice();
}


async function init(){
  [model, products, arcsite] = await Promise.all([
    fetch("./decision-tree.json").then(r=>r.json()),
    fetch("./products.json").then(r=>r.json()),
    fetch("./arscite-objects.json").then(r=>r.json())
  ]);

  loadState();
  bindJobFields();
  renderQuestions();
  renderFieldPrompts();
  initPerimeterUI();
  bindDisposition();

  computeAndRender();
  renderSummary();

  $("resetAnswers").onclick = () => { state.answers={}; saveState(); renderQuestions(); computeAndRender(); };
  $("saveNow").onclick = () => { saveJobFields(); saveState(); toast("Saved."); };

  $("closeFlightPlan").onclick = () => $("flightPlanCard").style.display="none";
  $("addLineItem").onclick = () => addCustomLineItem();

  $("togglePreview").onclick = () => toggleHandoffPreview();
  $("printSummary").onclick = () => printHandoff();

  $("copySummary").onclick = async () => {
    const text = buildSummaryText();
    try { await navigator.clipboard.writeText(text); toast("Copied."); }
    catch { alert("Copy failed. You can manually select/copy from the summary box."); }
  };

  $("exportBtn").onclick = exportJSON;
  $("importFile").addEventListener("change", importJSON);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(()=>{}));
  }
}

/* ---------------- Storage ---------------- */

function loadState(){
  const raw = localStorage.getItem(STORAGE_KEY);
  if(!raw) return;
  try { state = { ...state, ...JSON.parse(raw) }; } catch {}
}
function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

/* ---------------- Job fields ---------------- */

function bindJobFields(){
  $("jobAddress").value = state.job.address || "";
  $("jobHomeowner").value = state.job.homeowner || "";
  $("jobDate").value = state.job.date || "";
  $("jobNotes").value = state.job.notes || "";

  ["jobAddress","jobHomeowner","jobDate","jobNotes"].forEach(id=>{
    $(id).addEventListener("input", ()=>{
      saveJobFields(); saveState(); refreshSummaryAndPreview();
    });
  });
}
function saveJobFields(){
  state.job.address = $("jobAddress").value || "";
  state.job.homeowner = $("jobHomeowner").value || "";
  state.job.date = $("jobDate").value || "";
  state.job.notes = $("jobNotes").value || "";
}

/* ---------------- Logic Checklist ---------------- */

function renderQuestions(){
  const host = $("questionHost");
  host.innerHTML = "";
  model.questions.forEach(q=>{
    const wrap = document.createElement("div");
    wrap.className = "q";

    const qt = document.createElement("div");
    qt.className = "qt";
    qt.textContent = q.text;
    wrap.appendChild(qt);

    const opts = document.createElement("div");
    opts.className = "opts";

    q.options.forEach(opt=>{
      const btn = document.createElement("button");
      btn.type="button";
      btn.className = "opt" + (state.answers[q.id]===opt.value ? " active":"");
      btn.textContent = opt.label;
      btn.onclick = ()=>{
        state.answers[q.id]=opt.value;
        saveState();
        renderQuestions();
        computeAndRender();
      };
      opts.appendChild(btn);
    });

    wrap.appendChild(opts);
    host.appendChild(wrap);
  });
}

function deriveTags(){
  const tags = new Set();
  model.questions.forEach(q=>{
    const val = state.answers[q.id];
    if(!val) return;
    const opt = q.options.find(o=>o.value===val);
    (opt?.tags||[]).forEach(t=>tags.add(t));
  });
  return Array.from(tags);
}

function applyRules(tags){
  const tset = new Set(tags);
  state.solutionNotes = state.solutionNotes || {};
  (model.rules||[]).forEach(rule=>{
    const ok = (rule.ifAllTags||[]).every(t=>tset.has(t));
    if(!ok) return;
    const sid = rule.then?.addNotesToSolution;
    const note = rule.then?.note;
    if(sid && note){
      state.solutionNotes[sid] = state.solutionNotes[sid] || [];
      if(!state.solutionNotes[sid].includes(note)) state.solutionNotes[sid].push(note);
    }
  });
}

function filterSolutions(tags){
  const tset = new Set(tags);
  return model.solutions
    .filter(s => {
      const trigTags = (s.tags||[]);
      const reqTags  = (s.requiredTags||[]);
      const triggerOk = trigTags.length ? trigTags.some(t=>tset.has(t)) : true;
      // requiredTags here represent *eligible* foundation types (any-match)
      const reqOk = reqTags.length ? reqTags.some(t=>tset.has(t)) : true;
      return triggerOk && reqOk;
    })
    .map(s=>s.id);
}

function computeAndRender(){
  state.tags = deriveTags();
  applyRules(state.tags);
  state.suggestedSolutionIds = filterSolutions(state.tags);

  // Ensure default flight plans exist
  state.suggestedSolutionIds.forEach(id=>{
    if(!state.flightPlans[id]){
      const sol = model.solutions.find(s=>s.id===id);
      state.flightPlans[id] = structuredClone(sol?.defaults?.flightPlan || []);
    }
  });

  saveState();
  renderSolutions();
  regenDispositionNotesAndPlan(false);
  refreshSummaryAndPreview();
}

function renderSolutions(){
  const host = $("solutionHost");
  host.innerHTML = "";
  if(!state.suggestedSolutionIds.length){
    host.innerHTML = `<div class="hint">No solutions suggested yet. Answer the checklist.</div>`;
    return;
  }
  state.suggestedSolutionIds.forEach(id=>{
    const sol = model.solutions.find(s=>s.id===id);
    const chip = document.createElement("div");
    chip.className="chip";
    const btn = document.createElement("button");
    btn.type="button";
    btn.textContent = sol.name;
    btn.onclick = ()=>openFlightPlan(id);
    chip.appendChild(btn);
    host.appendChild(chip);
  });
}

/* ---------------- Flight Plan ---------------- */



function openFlightPlan(solutionId){
  const card = document.getElementById("flightPlanCard");
  const titleEl = document.getElementById("flightPlanTitle");
  const hintsEl = document.getElementById("flightPlanHints");
  const hostEl  = document.getElementById("flightPlanHost");

  const sol = model.solutions.find(s=>s.id===solutionId);
  titleEl.textContent = sol ? sol.title : solutionId;

  if(!state.flightPlans[solutionId]) state.flightPlans[solutionId] = { lines:[], notes:"" };
  const plan = state.flightPlans[solutionId];

  // ---------- helpers ----------
  const getFoundationKey = () => {
    const v = state.answers["foundation_type"];
    if(v==="basement") return "basement";
    if(v==="crawlspace") return "crawlspace";
    if(v==="slab") return "slab";
    return "any"; // multiple/missing
  };

  const getCityFromAddress = () => {
    const addr = (document.getElementById("jobAddress")?.value || "").trim();
    const parts = addr.split(",").map(s=>s.trim()).filter(Boolean);
    // common: street, City, ST ZIP
    if(parts.length >= 2) return parts[1];
    return "";
  };

  const addLineIfMissing = (name) => {
    const exists = plan.lines.some(l => (l.name||"").toLowerCase() === name.toLowerCase());
    if(exists) return;
    plan.lines.push({ name, qty: 1, unit: "EA", unitCost: 0 });
  };

  const removeLineByName = (name) => {
    plan.lines = plan.lines.filter(l => (l.name||"").toLowerCase() !== name.toLowerCase());
  };

  const city = getCityFromAddress().toLowerCase();
  const foundationKey = getFoundationKey();

  // ---------- product suggestions (shown only after engine picks a system category) ----------
  const catalog = products.solutionProducts?.[solutionId] || {};
  const suggestedProducts = []
    .concat(catalog["any"] || [])
    .concat(catalog[foundationKey] || []);

  // ---------- auto + manual add-ons ----------
  const autoAddOns = products.addOns?.auto || [];
  const manualAddOns = products.addOns?.manual || [];

  const autoDefaultChecked = (id) => {
    if(id === "utilities_protection"){
      return ["control_groundwater","stabilize_perimeter","stabilize_walls","stabilize_concrete"].includes(solutionId);
    }
    if(id === "permit_package_a"){
      if(city.includes("atlanta")) return true; // Atlanta: permits regardless of contract size
      if(city.includes("stone mountain") && solutionId.startsWith("stabilize")) return true; // Stone Mountain: permit for all structure work
      return ["stabilize_perimeter","stabilize_walls","stabilize_floor_framing","stabilize_concrete"].includes(solutionId);
    }
    if(id === "arborist_survey"){
      return city.includes("atlanta"); // Atlanta: arborist + land survey requirement
    }
    return false;
  };

  // ---------- render ----------
  card.classList.remove("hidden");
  hostEl.innerHTML = "";
  hintsEl.innerHTML = "";

  const hintLines = [];
  hintLines.push("Products only show up here *after* the recommendation engine suggests a system category.");
  hintLines.push("Auto add-ons are pre-checked when local rules commonly require them (you can uncheck).");
  if(city.includes("atlanta")){
    hintLines.push("Atlanta note: permit required regardless of contract size; land survey + arborist fee placeholder $2,500.");
  }
  if(city.includes("stone mountain")){
    hintLines.push("Stone Mountain note: permit required for structural work (includes IntelliJack/floor support items).");
  }
  hintsEl.innerHTML = "<ul>"+hintLines.map(h=>`<li>${escapeHtml(h)}</li>`).join("")+"</ul>";

  const section = (title) => {
    const div = document.createElement("div");
    div.className = "fp-section";
    const h = document.createElement("h4");
    h.textContent = title;
    div.appendChild(h);
    return div;
  };

  const checklist = (items, defaultCheckedFn) => {
    const wrap = document.createElement("div");
    wrap.className = "fp-checklist";
    items.forEach(it => {
      const row = document.createElement("label");
      row.className = "chk";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = defaultCheckedFn ? !!defaultCheckedFn(it.id) : false;
      cb.addEventListener("change", () => {
        if(cb.checked) addLineIfMissing(it.label);
        else removeLineByName(it.label);
        renderLines();
      });
      const span = document.createElement("span");
      span.textContent = it.label;
      row.appendChild(cb);
      row.appendChild(span);
      wrap.appendChild(row);

      if(cb.checked) addLineIfMissing(it.label);
    });
    return wrap;
  };

  const productItems = suggestedProducts.map((p,i)=>({ id:`p_${i}`, label:p }));
  if(productItems.length){
    const s = section("Suggested products for this system category");
    s.appendChild(checklist(productItems, () => false));
    hostEl.appendChild(s);
  }

  if(autoAddOns.length){
    const s = section("Auto-suggested add-ons");
    s.appendChild(checklist(autoAddOns, autoDefaultChecked));
    hostEl.appendChild(s);
  }

  if(manualAddOns.length){
    const s = section("Manual add-ons");
    s.appendChild(checklist(manualAddOns, () => false));
    hostEl.appendChild(s);
  }

  const linesSection = section("Selected line items (edit qty/unit/cost)");
  const linesContainer = document.createElement("div");
  linesContainer.id = "flightPlanLines";
  linesSection.appendChild(linesContainer);
  hostEl.appendChild(linesSection);

  function renderLines(){
    linesContainer.innerHTML = "";
    plan.lines.forEach((ln, idx) => linesContainer.appendChild(renderLineItem(solutionId, idx, ln)));
  }
  renderLines();

  // bind add line and close
  document.getElementById("addLineItem").onclick = () => {
    plan.lines.push({ name:"", qty:1, unit:"EA", unitCost:0 });
    renderLines();
  };
  document.getElementById("closeFlightPlan").onclick = () => {
    card.classList.add("hidden");
    computeAndRender();
  };
}


function updateLine(solutionId, idx, patch){
  const plan = normalizeFlightPlan(state.flightPlans[solutionId]);
  state.flightPlans[solutionId] = plan;
  const existing = plan.lines[idx] || { item:"", qty:1, notes:"" };
  plan.lines[idx] = { ...existing, ...patch };
  saveState();
  // keep the UI and summary in sync
  renderSummary();
}


function addCustomLineItem(){
  const sid = $("flightPlanCard").dataset.openSolutionId;
  if(!sid) return;
  const sol = model.solutions.find(s=>s.id===sid);
  state.flightPlans[sid].push({ item:"", unit: sol.flightPlanUnits?.[0] || "EA", qty:0, notes:"", arcsiteObject:"" });
  saveState();
  openFlightPlan(sid);
  refreshSummaryAndPreview();
}

/* ---------------- Field Prompts ---------------- */

function renderFieldPrompts(){
  const host = $("fieldPrompts");
  host.innerHTML = "";
  FIELD_PROMPTS.forEach(p=>{
    const row = document.createElement("div");
    row.className = "item";
    const cb = document.createElement("input");
    cb.type="checkbox";
    cb.checked = !!state.promptsDone[p.id];
    cb.onchange = ()=>{
      state.promptsDone[p.id] = cb.checked;
      saveState();
      refreshSummaryAndPreview();
    };
    const txt = document.createElement("div");
    txt.textContent = p.text;
    row.appendChild(cb);
    row.appendChild(txt);
    host.appendChild(row);
  });
}

/* ---------------- Perimeter + Drawing ---------------- */

function initPerimeterUI(){
  $("modeRect").onclick = ()=>setPerimMode("rect");
  $("modeWalk").onclick = ()=>setPerimMode("walk");
  $("clearPerimeter").onclick = ()=>{
    state.perimeter.rect={L:0,W:0,H:0};
    state.perimeter.segments=[{len:10,turnDeg:90},{len:10,turnDeg:90},{len:10,turnDeg:90},{len:10,turnDeg:90}];
    state.perimeter.points=[];
    saveState();
    syncPerimInputs();
    drawPerimeter();
    refreshSummaryAndPreview();
  };

  $("applyRect").onclick = ()=>{
    state.perimeter.rect.L = Number($("rectL").value||0);
    state.perimeter.rect.W = Number($("rectW").value||0);
    state.perimeter.rect.H = Number($("wallH").value||0);
    state.perimeter.mode="rect";
    computeRectPoints();
    saveState();
    drawPerimeter();
    refreshSummaryAndPreview();
  };

  $("addSeg").onclick = ()=>{
    state.perimeter.segments.push({len:0, turnDeg:90});
    saveState();
    renderSegmentsUI();
  };

  $("applyWalk").onclick = ()=>{
    state.perimeter.mode="walk";
    computeWalkPoints();
    saveState();
    drawPerimeter();
    refreshSummaryAndPreview();
  };

  $("applyAutoQuant").onclick = ()=>{
    applyAutoQuantitiesFromMeasurements();
    saveState();
    refreshSummaryAndPreview();
    toast("Auto-filled quantities.");
  };

  syncPerimInputs();
  renderSegmentsUI();

  if(state.perimeter.mode==="rect") computeRectPoints(); else computeWalkPoints();
  drawPerimeter();
}

function setPerimMode(mode){
  state.perimeter.mode = mode;
  $("rectPanel").style.display = mode==="rect" ? "block" : "none";
  $("walkPanel").style.display = mode==="walk" ? "block" : "none";
  if(mode==="rect") computeRectPoints(); else computeWalkPoints();
  saveState();
  drawPerimeter();
  refreshSummaryAndPreview();
}

function syncPerimInputs(){
  $("rectL").value = state.perimeter.rect.L || "";
  $("rectW").value = state.perimeter.rect.W || "";
  $("wallH").value = state.perimeter.rect.H || "";
  $("rectPanel").style.display = state.perimeter.mode==="rect" ? "block" : "none";
  $("walkPanel").style.display = state.perimeter.mode==="walk" ? "block" : "none";
}

function renderSegmentsUI(){
  const host = $("segmentsHost");
  host.innerHTML = "";
  state.perimeter.segments.forEach((s, idx)=>{
    const row = document.createElement("div");
    row.className="line";
    row.style.gridTemplateColumns="1fr 1fr 1fr";

    const len = document.createElement("input");
    len.type="number"; len.step="0.1"; len.min="0";
    len.value = Number(s.len||0);
    len.placeholder="Length (ft)";
    len.oninput = ()=>{ s.len=Number(len.value||0); saveState(); };

    const turn = document.createElement("input");
    turn.type="number"; turn.step="1";
    turn.value = Number(s.turnDeg||0);
    turn.placeholder="Turn (deg)";
    turn.oninput = ()=>{ s.turnDeg=Number(turn.value||0); saveState(); };

    const del = document.createElement("button");
    del.className="danger"; del.type="button";
    del.textContent="Del";
    del.onclick = ()=>{
      state.perimeter.segments.splice(idx,1);
      saveState();
      renderSegmentsUI();
    };

    row.appendChild(len); row.appendChild(turn); row.appendChild(del);
    host.appendChild(row);
  });
}

function computeRectPoints(){
  const L = Number(state.perimeter.rect.L||0);
  const W = Number(state.perimeter.rect.W||0);
  if(L<=0 || W<=0){
    state.perimeter.points=[];
    updatePerimOutputs(0,0,0);
    return;
  }
  const pts = [[0,0],[L,0],[L,W],[0,W],[0,0]];
  state.perimeter.points = pts;
  updatePerimOutputs(2*(L+W), L*W, 0);
}

function computeWalkPoints(){
  const segs = state.perimeter.segments || [];
  let x=0, y=0, heading=0;
  const pts=[[0,0]];
  let per=0;

  for(const s of segs){
    const len = Number(s.len||0);
    const rad = heading*Math.PI/180;
    x += len*Math.cos(rad);
    y += len*Math.sin(rad);
    pts.push([x,y]);
    per += len;
    heading += Number(s.turnDeg||0);
  }

  state.perimeter.points = pts;
  const closure = Math.hypot(x,y);
  const area = polygonArea(pts);
  updatePerimOutputs(per, area, closure);
}

function polygonArea(pts){
  if(pts.length < 3) return 0;
  let sum=0;
  for(let i=0;i<pts.length-1;i++){
    const [x1,y1]=pts[i];
    const [x2,y2]=pts[i+1];
    sum += (x1*y2 - x2*y1);
  }
  return Math.abs(sum)/2;
}

function updatePerimOutputs(per, area, closure){
  $("perimOut").value = round(per,1);
  $("areaOut").value = round(area,1);
  $("closureOut").value = round(closure,2);
}

function drawPerimeter(){
  const canvas = $("planCanvas");
  const ctx = canvas.getContext("2d");
  const pts = state.perimeter.points || [];
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = "#0c0f18";
  ctx.fillRect(0,0,canvas.width,canvas.height);

  if(pts.length < 2){
    ctx.fillStyle = "rgba(233,238,247,.7)";
    ctx.font = "18px system-ui";
    ctx.fillText("No perimeter drawn yet.", 20, 40);
    return;
  }

  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  pts.forEach(([x,y])=>{ minX=Math.min(minX,x); minY=Math.min(minY,y); maxX=Math.max(maxX,x); maxY=Math.max(maxY,y); });
  const w = (maxX-minX)||1, h=(maxY-minY)||1;
  const pad=60;
  const scale = Math.min((canvas.width-2*pad)/w, (canvas.height-2*pad)/h);
  const tx = (x)=> (x-minX)*scale + pad;
  const ty = (y)=> canvas.height - ((y-minY)*scale + pad);

  ctx.lineWidth=3;
  ctx.strokeStyle="rgba(59,130,246,1)";
  ctx.beginPath();
  ctx.moveTo(tx(pts[0][0]), ty(pts[0][1]));
  for(let i=1;i<pts.length;i++) ctx.lineTo(tx(pts[i][0]), ty(pts[i][1]));
  ctx.stroke();

  ctx.fillStyle="rgba(233,238,247,1)";
  ctx.font="12px ui-monospace, SFMono-Regular, Menlo, monospace";
  pts.forEach(([x,y], i)=>{
    const cx=tx(x), cy=ty(y);
    ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI*2); ctx.fill();
    ctx.fillText(`${i}`, cx+6, cy-6);
  });

  ctx.fillStyle="rgba(233,238,247,.85)";
  ctx.font="14px system-ui";
  ctx.fillText(`Perimeter: ${$("perimOut").value} ft   Area: ${$("areaOut").value} sf   Closure: ${$("closureOut").value} ft`, 18, 26);
}

function round(n,d){ const p=Math.pow(10,d); return String(Math.round((Number(n)||0)*p)/p); }

/* ---------------- Auto-Quantities from measurements ---------------- */

function applyAutoQuantitiesFromMeasurements(){
  const per = Number($("perimOut").value || 0);
  const area = Number($("areaOut").value || 0);
  const h = Number(state.perimeter.rect.H || 0);
  const wallSF = (per>0 && h>0) ? per*h : 0;

  function setQty(solutionId, keyword, unit, value){
    const fp = state.flightPlans[solutionId];
    if(!fp) return;
    const li = (fp.lines||[]).find(x => (x.item||"").toLowerCase().includes(keyword) && (x.unit||"")===unit);
    if(!li) return;
    li.qty = value;
  }

  if(state.flightPlans["drainage"] && per>0) setQty("drainage", "drain", "LF", per);
  if(state.flightPlans["encap"] && area>0) setQty("encap", "vapor", "SF", area);
  if(state.flightPlans["wall_liner"] && wallSF>0) setQty("wall_liner", "wall", "SF", wallSF);
}

/* ---------------- Disposition ---------------- */

function bindDisposition(){
  $("dispoStatus").value = state.dispo.status || "unknown";
  $("followupDate").value = state.dispo.followupDate || "";
  $("followupMethod").value = state.dispo.followupMethod || "call";
  $("dispoNotes").value = state.dispo.notes || "";
  $("followupPlan").innerHTML = state.dispo.plan ? escapeHtml(state.dispo.plan).replaceAll("\n","<br>") : "";

  $("dispoStatus").addEventListener("change", ()=>{
    state.dispo.status = $("dispoStatus").value;
    regenDispositionNotesAndPlan(true);
    saveState();
    refreshSummaryAndPreview();
  });

  ["followupDate","followupMethod"].forEach(id=>{
    $(id).addEventListener("change", ()=>{
      state.dispo.followupDate = $("followupDate").value || "";
      state.dispo.followupMethod = $("followupMethod").value || "call";
      regenDispositionNotesAndPlan(true);
      saveState();
      refreshSummaryAndPreview();
    });
  });

  $("dispoNotes").addEventListener("input", ()=>{
    state.dispo.notes = $("dispoNotes").value || "";
    saveState();
    refreshSummaryAndPreview();
  });

  $("regenDispo").onclick = ()=>{ regenDispositionNotesAndPlan(true, true, false); saveState(); refreshSummaryAndPreview(); };
  $("regenPlan").onclick = ()=>{ regenDispositionNotesAndPlan(true, false, true); saveState(); refreshSummaryAndPreview(); };
}

function regenDispositionNotesAndPlan(updateUI, forceNotes=false, forcePlan=false){
  const status = state.dispo.status || "unknown";
  const date = state.dispo.followupDate || "";
  const method = state.dispo.followupMethod || "call";

  const address = state.job.address || "(address)";
  const sols = state.suggestedSolutionIds.map(id => model.solutions.find(s=>s.id===id)?.name || id);

  if(forceNotes || !state.dispo.notes){
    state.dispo.notes = buildDispoNotesTemplate(status, address, sols);
    $("dispoNotes").value = state.dispo.notes;
  }
  if(forcePlan || !state.dispo.plan){
    state.dispo.plan = buildFollowupPlan(status, date, method, sols);
    $("followupPlan").innerHTML = escapeHtml(state.dispo.plan).replaceAll("\n","<br>");
  }

  if(updateUI){
    $("dispoNotes").value = state.dispo.notes || "";
    $("followupPlan").innerHTML = state.dispo.plan ? escapeHtml(state.dispo.plan).replaceAll("\n","<br>") : "";
  }
}

function buildDispoNotesTemplate(status, address, sols){
  const solLine = sols.length ? sols.join(", ") : "No solutions generated yet";
  const now = new Date().toISOString().slice(0,10);

  if(status==="sold"){
    return `SOLD (${now})
Address: ${address}
Recommended: ${solLine}
Customer confirmed proceeding. Next steps: schedule install, confirm access constraints, verify discharge route, confirm electrical needs (if dehu/sump).`;
  }
  if(status==="not_sold"){
    return `NOT SOLD (${now})
Address: ${address}
Recommended: ${solLine}
Customer did not move forward today. Document objections (price, timing, trust, competing bids, uncertainty). Capture what would change their mind.`;
  }
  if(status==="needs_followup"){
    return `NEEDS FOLLOW-UP (${now})
Address: ${address}
Recommended: ${solLine}
Pending decision. Identify missing info (financing, spouse approval, scope clarity, additional photos/measurements).`;
  }
  return `DISPOSITION UNKNOWN (${now})
Address: ${address}
Recommended: ${solLine}
Update status after discussion.`;
}

function buildFollowupPlan(status, followupDate, method, sols){
  const solLine = sols.length ? sols.join(", ") : "(no solutions yet)";
  const dateLine = followupDate ? `Target date: ${followupDate}` : "Target date: (set a date)";

  if(status==="sold"){
    return `FOLLOW-UP PLAN (Sold)
${dateLine}
1) ${method.toUpperCase()}: confirm scheduling window + installer access
2) Send scope summary + what to expect day-of
3) Confirm any pre-work: clearing, pets, electrical outlets, discharge routing
4) Internal: create job ticket + attach handoff + photos`;
  }
  if(status==="not_sold"){
    return `FOLLOW-UP PLAN (Not Sold)
${dateLine}
1) ${method.toUpperCase()}: ask for decision driver (price/timing/uncertainty)
2) Offer 2 options: "minimum fix" vs "full system" tied to ${solLine}
3) Provide proof: warranty, references, before/after photos, moisture readings
4) Set next touchpoint + leave a single clear next step`;
  }
  if(status==="needs_followup"){
    return `FOLLOW-UP PLAN (Needs Follow-up)
${dateLine}
1) ${method.toUpperCase()}: answer open questions + summarize scope
2) Provide missing artifacts: drawing, measurements, itemized options, financing
3) Confirm decision-maker(s) and timeline
4) Lock in next appointment or call window`;
  }
  return `FOLLOW-UP PLAN
${dateLine}
1) Set status (sold / not sold / needs follow-up)
2) Confirm decision-maker and timeline
3) Next touchpoint via ${method}`;
}

/* ---------------- Handoff Preview + Print ---------------- */

function refreshSummaryAndPreview(){
  renderSummary();
  const previewHost = $("handoffPreview");
  if(previewHost && previewHost.style.display !== "none") renderHandoffPreview();
}

function getHandoffWarnings(){
  const w=[];
  if(!state.job.address?.trim()) w.push("Missing Address");
  if(!state.job.date?.trim()) w.push("Missing Date");
  if(state.dispo.status==="unknown") w.push("Disposition is Unknown");
  return w;
}

function buildHandoffInnerHtml(text){
  const warnings = getHandoffWarnings();
  const warnBlock = warnings.length
    ? `<div class="warn"><strong>⚠ Review:</strong><ul>${warnings.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ul></div>`
    : "";

  const metaParts = [];
  if(state.job.address) metaParts.push(escapeHtml(state.job.address));
  if(state.job.date) metaParts.push(escapeHtml(state.job.date));

  return `
    <div class="handoff-sheet">
      <div class="handoff-title">CFI Job Handoff</div>
      <div class="handoff-meta">${metaParts.join(" • ")}</div>
      ${warnBlock}
      <pre>${escapeHtml(text)}</pre>
    </div>
  `;
}

function renderHandoffPreview(){
  const host = $("handoffPreview");
  host.innerHTML = buildHandoffInnerHtml(buildSummaryText());
}

function toggleHandoffPreview(){
  const host = $("handoffPreview");
  const btn = $("togglePreview");
  const isOpen = host.style.display !== "none";
  if(isOpen){
    host.style.display="none";
    btn.textContent="Preview Handoff";
    return;
  }
  renderHandoffPreview();
  host.style.display="block";
  btn.textContent="Hide Preview";
  host.scrollIntoView({behavior:"smooth", block:"start"});
}

function printHandoff(){
  saveJobFields();
  const missing=[];
  if(!state.job.address?.trim()) missing.push("Address");
  if(!state.job.date?.trim()) missing.push("Date");
  if(missing.length){ alert("Cannot print yet. Missing: " + missing.join(", ")); return; }
  window.print();
}

/* ---------------- Summary builder ---------------- */

function buildSummaryText(){
  const lines=[];
  const {address, homeowner, date, notes}=state.job;

  lines.push("CFI JOB HANDOFF");
  lines.push("==============");
  if(address) lines.push(`Address: ${address}`);
  if(homeowner) lines.push(`Homeowner: ${homeowner}`);
  if(date) lines.push(`Date: ${date}`);
  if(notes) lines.push(`Notes: ${notes}`);
  lines.push("");

  lines.push("PERIMETER / AREA");
  lines.push("----------------");
  lines.push(`Mode: ${state.perimeter.mode}`);
  lines.push(`Perimeter: ${$("perimOut").value} ft`);
  lines.push(`Area: ${$("areaOut").value} sq ft`);
  lines.push(`Closure error: ${$("closureOut").value} ft`);
  if(state.perimeter.rect.H) lines.push(`Wall height: ${state.perimeter.rect.H} ft`);
  lines.push("");

  lines.push("ANSWERS");
  lines.push("-------");
  model.questions.forEach(q=>{
    const v=state.answers[q.id];
    if(!v) return;
    const opt=q.options.find(o=>o.value===v);
    lines.push(`- ${q.text}: ${opt?.label || v}`);
  });
  lines.push("");

  lines.push("SUGGESTED SOLUTIONS");
  lines.push("-------------------");
  if(!state.suggestedSolutionIds.length) lines.push("- (none yet)");
  state.suggestedSolutionIds.forEach(id=>{
    const sol=model.solutions.find(s=>s.id===id);
    lines.push(`- ${sol.name}`);
    (state.solutionNotes?.[id]||[]).forEach(n=>lines.push(`  • NOTE: ${n}`));
  });
  lines.push("");

  lines.push("FLIGHT PLAN");
  lines.push("-----------");
  state.suggestedSolutionIds.forEach(id=>{
    const sol=model.solutions.find(s=>s.id===id);
    lines.push(sol.name);
    const fp = normalizeFlightPlan(state.flightPlans[id]);
    if(!(fp.lines||[]).length){ lines.push("  (no line items)"); lines.push(""); return; }
    (fp.lines||[]).forEach(li=>{
      lines.push(`  • ${li.item || "(item)"}: ${Number(li.qty||0)} ${li.unit || ""}${li.arcsiteObject ? ` [ArcSite: ${li.arcsiteObject}]` : ""}${li.notes ? ` — ${li.notes}` : ""}`);
    });
    lines.push("");
  });

  lines.push("FIELD PROMPTS");
  lines.push("-------------");
  FIELD_PROMPTS.forEach(p=>{
    lines.push(`- [${state.promptsDone[p.id] ? "x":" "}] ${p.text}`);
  });
  lines.push("");

  lines.push("DISPOSITION");
  lines.push("-----------");
  lines.push(`Status: ${state.dispo.status}`);
  if(state.dispo.followupDate) lines.push(`Next contact: ${state.dispo.followupDate} via ${state.dispo.followupMethod}`);
  lines.push("");
  lines.push("Disposition notes:");
  lines.push(state.dispo.notes || "(none)");
  lines.push("");
  lines.push("Follow-up plan:");
  lines.push(state.dispo.plan || "(none)");

  return lines.join("\n");
}

function renderSummary(){
  $("summaryHost").innerHTML = `<div class="summary"><pre>${escapeHtml(buildSummaryText())}</pre></div>`;
}

/* ---------------- Export / Import ---------------- */

function exportJSON(){
  saveJobFields();
  const payload = { exportedAt:new Date().toISOString(), modelVersion:model.version, state };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href=url;
  a.download = `CFI_${(state.job.address||"job").replace(/[^a-z0-9]+/gi,"_").slice(0,40)}_${state.job.date||"date"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importJSON(e){
  const file = e.target.files?.[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const payload = JSON.parse(reader.result);
      if(!payload?.state) throw new Error("Invalid file.");
      state = payload.state;
      saveState();
      bindJobFields();
      renderQuestions();
      renderFieldPrompts();
      syncPerimInputs();
      renderSegmentsUI();
      if(state.perimeter.mode==="rect") computeRectPoints(); else computeWalkPoints();
      drawPerimeter();
      bindDisposition();
      computeAndRender();
      toast("Imported.");
    }catch(err){ alert("Import failed: " + err.message); }
  };
  reader.readAsText(file);
}

/* ---------------- Utils ---------------- */

function toast(msg){
  const t=document.createElement("div");
  t.textContent=msg;
  t.style.position="fixed"; t.style.bottom="14px"; t.style.left="50%";
  t.style.transform="translateX(-50%)";
  t.style.background="rgba(0,0,0,.75)"; t.style.color="white";
  t.style.padding="10px 12px"; t.style.borderRadius="999px";
  t.style.border="1px solid rgba(255,255,255,.1)";
  t.style.zIndex="9999";
  document.body.appendChild(t);
  setTimeout(()=>t.remove(), 1200);
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

init();
