"use strict";

/**
 * signal_optimizer.js  v2
 *
 * Self-calibrating signal weight optimizer.
 *
 * REALISTIC ACCURACY TARGETS (NBA is hard to predict):
 *   Overall accuracy target:   ≥ 58%  (even 55% is profitable with positive edge)
 *   Bet-now accuracy target:   ≥ 65%  (high-confidence picks must beat 60%)
 *   Max accuracy cap:          ≤ 72%  (above this = overfitting on sample)
 *
 * Why these numbers:
 *   The best sharp sportsbooks expect to be right ~54-57% on all games.
 *   What matters is not raw accuracy but CALIBRATION — does an 0.05 edge
 *   actually mean you win more than the market's implied probability?
 *   We optimise for both accuracy AND calibration error simultaneously.
 *
 * HOW IT WORKS:
 *   1. Load all graded snapshots (live games + backfill)
 *   2. Extract signal logit values stored in each snapshot
 *   3. Phase 1: Adam gradient descent on custom loss
 *   4. Phase 2: Simulated annealing to escape local minima
 *   5. Validate improvement, save only if genuine gain
 *   6. Full audit trail to data/optimizer_audit.json
 *
 * CUSTOM LOSS = BCE + calibration_error × 0.4 + overconfidence_penalty × 0.2 + L2
 *
 * Run standalone:     node signal_optimizer.js
 * Run report only:    node signal_optimizer.js --report
 * Run from grader:    require("./signal_optimizer").runSignalOptimizer(snaps)
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR     = path.join(__dirname, "data");
const SIG_W_FILE   = path.join(DATA_DIR, "signal_weights.json");
const AUDIT_FILE   = path.join(DATA_DIR, "optimizer_audit.json");

// ─── realistic targets ────────────────────────────────────────────────────────
const MIN_SAMPLES          = 50;
const MIN_SIGNAL_SAMPLES   = 20;
const TARGET_OVERALL_LOW   = 0.58;   // min acceptable overall accuracy
const TARGET_OVERALL_HIGH  = 0.72;   // max before suspecting overfit
const TARGET_BET_NOW       = 0.65;   // min for "Bet now" accuracy
const MIN_IMPROVEMENT      = 0.003;  // must improve by 0.3% to save

// ─── optimizer hyperparameters ────────────────────────────────────────────────
const LR          = 0.004;
const MAX_EPOCHS  = 4000;
const L2          = 0.07;
const ANNEAL_STEPS = 600;
const ANNEAL_TEMP  = 0.09;
const ANNEAL_DECAY = 0.993;

// ─── default weights ──────────────────────────────────────────────────────────
const DEFAULT_W = {
  officialNetRating:0.17,injuryAdjNetRating:0.10,predictedSpread:0.10,
  pie:0.08,recentForm:0.08,clutch:0.07,starPower:0.06,shooting:0.05,
  turnover:0.04,rest:0.04,hustle:0.03,rebound:0.03,shotQuality:0.03,
  h2h:0.03,momentum:0.03,referee:0.03,travelFatigue:0.03,
  opponentMatchup:0.02,splits:0.02,pace:0.02,threePointVariance:0.01,defense:0.01,
};

const W_BOUNDS = Object.fromEntries(Object.keys(DEFAULT_W).map(k => [k, { lo: 0.0, hi: 0.45 }]));
W_BOUNDS.officialNetRating.hi   = 0.50;
W_BOUNDS.injuryAdjNetRating.hi  = 0.40;
W_BOUNDS.predictedSpread.hi     = 0.40;
W_BOUNDS.pie.hi                 = 0.30;
W_BOUNDS.recentForm.hi          = 0.30;

// ─── math ─────────────────────────────────────────────────────────────────────
const clamp   = (x,lo,hi) => Math.max(lo,Math.min(hi,x));
const sigmoid = x => 1/(1+Math.exp(-clamp(x,-50,50)));
const logit   = p => { const c=clamp(p,1e-7,1-1e-7); return Math.log(c/(1-c)); };
const r4 = n => Math.round(n*10000)/10000;
const r2 = n => Math.round(n*100)/100;

// ─── file I/O ─────────────────────────────────────────────────────────────────
function ensureDir(){ if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true}); }

function loadWeights(file, defaults) {
  try {
    ensureDir(); if(!fs.existsSync(file))return{...defaults};
    const raw=fs.readFileSync(file,"utf8").trim(); if(!raw)return{...defaults};
    const s=JSON.parse(raw); return{...defaults,...(s.weights||{})};
  } catch { return{...defaults}; }
}

function saveWeights(file, weights, meta={}) {
  try {
    ensureDir();
    fs.writeFileSync(file,JSON.stringify({weights,meta:{...meta,savedAt:new Date().toISOString(),version:4}},null,2),"utf8");
    return true;
  } catch(e){ console.error("[optimizer] save failed:",e.message); return false; }
}

function saveAudit(entry) {
  try {
    ensureDir(); let ex=[];
    if(fs.existsSync(AUDIT_FILE)){try{ex=JSON.parse(fs.readFileSync(AUDIT_FILE,"utf8"));}catch{ex=[];}}
    ex.push({...entry,ts:new Date().toISOString()});
    if(ex.length>50)ex=ex.slice(-50);
    fs.writeFileSync(AUDIT_FILE,JSON.stringify(ex,null,2),"utf8");
  } catch{}
}

// ─── feature extraction ───────────────────────────────────────────────────────
function extractFeatures(snap) {
  if (!snap?.result||typeof snap.result.modelWon!=="boolean") return null;

  const won   = snap.result.modelWon?1:0;
  const edge  = typeof snap.calibratedEdge==="number"?snap.calibratedEdge:typeof snap.rawEdge==="number"?snap.rawEdge:null;
  const prob  = typeof snap.calibratedTrueProbability==="number"?snap.calibratedTrueProbability:typeof snap.trueProbability==="number"?snap.trueProbability:null;
  const implied = typeof snap.impliedProbability==="number"?snap.impliedProbability:null;

  if (prob===null||implied===null) return null;

  const signals={};
  const raw=snap.statsSignals||{};
  for (const[k,v] of Object.entries(raw)) {
    const p=typeof v==="object"?Number(v.prob):Number(v);
    if (Number.isFinite(p)&&p>0&&p<1) signals[k]=logit(p);
  }
  const hasSignals=Object.keys(signals).length>=5;

  return{won,prob,implied,edge,verdict:snap.verdict,mode:snap.mode||snap.source||"unknown",
    signals:hasSignals?signals:null};
}

// ─── predict ──────────────────────────────────────────────────────────────────
function predict(f, w) {
  if (!f.signals) return f.prob;
  let ls=0, ws=0;
  for (const[k,lv] of Object.entries(f.signals)){const wt=w[k]||0;ls+=lv*wt;ws+=wt;}
  return ws===0?f.prob:clamp(sigmoid(ls),0.01,0.99);
}

// ─── custom loss ──────────────────────────────────────────────────────────────
function computeLoss(features, weights) {
  const eps=1e-7;
  let ce=0, calErr=0, overConf=0;
  const buckets={};

  for (const f of features) {
    const p=predict(f,weights), y=f.won;
    ce+=-(y*Math.log(p+eps)+(1-y)*Math.log(1-p+eps));
    const bk=Math.floor(p*20)*5;
    if(!buckets[bk])buckets[bk]={count:0,wins:0,sumP:0};
    buckets[bk].count++; buckets[bk].sumP+=p; if(y)buckets[bk].wins++;
    if(p>=0.80&&y===0)overConf+=(p-0.80)*2.5;
    if(p<=0.20&&y===1)overConf+=(0.20-p)*2.5;
  }

  ce/=features.length; overConf/=features.length;

  for (const b of Object.values(buckets)) {
    if(b.count<5)continue;
    const avg=b.sumP/b.count, act=b.wins/b.count;
    calErr+=(act-avg)**2;
  }
  calErr/=Math.max(Object.keys(buckets).length,1);

  // L2 toward defaults
  let reg=0;
  for (const k of Object.keys(DEFAULT_W)) reg+=(weights[k]-(DEFAULT_W[k]||0))**2;
  reg=L2*reg/features.length;

  return ce + calErr*0.4 + overConf*0.2 + reg;
}

// ─── accuracy metrics ─────────────────────────────────────────────────────────
function computeAccuracy(features, weights) {
  let total=0,correct=0,bnTotal=0,bnCorrect=0;
  const buckets={};

  for (const f of features) {
    const p=predict(f,weights); total++;
    if((p>=0.5)===(f.won===1))correct++;
    if(f.edge!=null&&Math.abs(f.edge)>=0.045){bnTotal++;if((p>=0.5)===(f.won===1))bnCorrect++;}
    const eb=f.edge!=null?Math.round(Math.abs(f.edge)*100):-1;
    const bk=eb<0?"?":eb<2?"<2%":eb<4?"2-4%":eb<6?"4-6%":eb<8?"6-8%":"8%+";
    if(!buckets[bk])buckets[bk]={total:0,correct:0};
    buckets[bk].total++; if((p>=0.5)===(f.won===1))buckets[bk].correct++;
  }

  // Calibration error across probability buckets
  const probBuckets={};
  for (const f of features) {
    const p=predict(f,weights); const bk=Math.floor(p*10)*10;
    if(!probBuckets[bk])probBuckets[bk]={n:0,wins:0,sumP:0};
    probBuckets[bk].n++; probBuckets[bk].sumP+=p; if(f.won)probBuckets[bk].wins++;
  }
  let calError=0, calBuckets=0;
  for (const b of Object.values(probBuckets)) {
    if(b.n<5)continue; calError+=Math.abs(b.wins/b.n-b.sumP/b.n); calBuckets++;
  }

  for (const b of Object.values(buckets)) b.accuracy=b.total>0?r4(b.correct/b.total):null;

  return{
    overall:total>0?r4(correct/total):null,
    betNow:bnTotal>0?r4(bnCorrect/bnTotal):null,
    samples:total, betNowSamples:bnTotal,
    calibrationError:calBuckets>0?r4(calError/calBuckets):null,
    byEdgeBucket:buckets
  };
}

// ─── numerical gradient ───────────────────────────────────────────────────────
function numGrad(features, weights, eps=1e-5) {
  const base=computeLoss(features,weights); const g={};
  for (const k of Object.keys(weights)){const wp={...weights,[k]:weights[k]+eps};g[k]=(computeLoss(features,wp)-base)/eps;}
  return g;
}

// ─── Adam ────────────────────────────────────────────────────────────────────
function runAdam(features, startW) {
  if (features.length<MIN_SAMPLES) return{weights:{...startW},improved:false};
  let w={...startW};
  const initL=computeLoss(features,w); let prevL=initL, bestL=initL, bestW={...w};
  const m=Object.fromEntries(Object.keys(w).map(k=>[k,0]));
  const v=Object.fromEntries(Object.keys(w).map(k=>[k,0]));
  const b1=0.9,b2=0.999,ea=1e-8; let t=0,stalled=0;

  for (let ep=0;ep<MAX_EPOCHS;ep++) {
    t++;
    const g=numGrad(features,w);
    for (const k of Object.keys(w)) {
      m[k]=b1*m[k]+(1-b1)*g[k]; v[k]=b2*v[k]+(1-b2)*g[k]**2;
      const mh=m[k]/(1-b1**t),vh=v[k]/(1-b2**t);
      w[k]-=LR*mh/(Math.sqrt(vh)+ea);
      const b=W_BOUNDS[k]; if(b)w[k]=clamp(w[k],b.lo,b.hi);
    }
    const cl=computeLoss(features,w);
    if(cl<bestL){bestL=cl;bestW={...w};stalled=0;}
    if(Math.abs(prevL-cl)<1e-7){stalled++;if(stalled>80){console.log(`[optimizer] Converged ep${ep+1}`);break;}}
    else stalled=0;
    prevL=cl;
  }
  return{weights:bestW,finalLoss:bestL,initialLoss:initL,improved:bestL<initL-1e-4};
}

// ─── Simulated annealing ──────────────────────────────────────────────────────
function runAnnealing(features, startW) {
  let cur={...startW},curL=computeLoss(features,cur),best={...cur},bestL=curL,temp=ANNEAL_TEMP;
  for (let i=0;i<ANNEAL_STEPS;i++) {
    const k=Object.keys(cur)[Math.floor(Math.random()*Object.keys(cur).length)];
    const delta=(Math.random()-0.5)*0.05;
    const prop={...cur,[k]:clamp(cur[k]+delta,W_BOUNDS[k]?.lo||0,W_BOUNDS[k]?.hi||0.50)};
    const propL=computeLoss(features,prop);
    const diff=propL-curL;
    if(diff<0||Math.random()<Math.exp(-diff/temp)){cur=prop;curL=propL;if(curL<bestL){bestL=curL;best={...cur};}}
    temp*=ANNEAL_DECAY;
  }
  return{weights:best,finalLoss:bestL};
}

// ─── normalise ────────────────────────────────────────────────────────────────
function normalise(w) {
  const sum=Object.values(w).reduce((s,v)=>s+Math.max(0,v),0);
  if(sum===0)return{...DEFAULT_W};
  const n={};
  for (const[k,v] of Object.entries(w)) n[k]=r4(Math.max(0,v)/sum);
  return n;
}

// ─── main export ──────────────────────────────────────────────────────────────
async function runSignalOptimizer(snapshots) {
  console.log(`\n[optimizer] ══════════════════════════════`);
  console.log(`[optimizer] Signal optimizer v2`);
  console.log(`[optimizer] Total snapshots: ${snapshots.length}`);
  ensureDir();

  const allF    = snapshots.map(extractFeatures).filter(Boolean);
  const signalF = allF.filter(f=>f.signals!==null);

  console.log(`[optimizer] Graded: ${allF.length}, with signals: ${signalF.length}`);

  if (allF.length<MIN_SAMPLES) {
    const msg=`Need ${MIN_SAMPLES} graded (have ${allF.length})`;
    console.log(`[optimizer] ${msg}`); return{ran:false,reason:msg};
  }

  const workingF = signalF.length>=MIN_SIGNAL_SAMPLES ? signalF : allF;
  console.log(`[optimizer] Working with ${workingF.length} features`);

  const currentW = loadWeights(SIG_W_FILE,DEFAULT_W);
  const baseline = computeAccuracy(workingF,currentW);
  console.log(`[optimizer] Baseline: ${(baseline.overall*100).toFixed(1)}% overall | ${baseline.betNow!=null?(baseline.betNow*100).toFixed(1)+"%":"n/a"} bet-now | cal_err=${baseline.calibrationError}`);

  // Phase 1: Adam
  const adamR=runAdam(workingF,currentW);
  // Phase 2: Anneal
  const annealR=runAnnealing(workingF,adamR.weights);
  const bestRaw=annealR.finalLoss<=adamR.finalLoss?annealR.weights:adamR.weights;
  const optW=normalise(bestRaw);

  const optimized=computeAccuracy(workingF,optW);
  console.log(`[optimizer] Optimized: ${(optimized.overall*100).toFixed(1)}% overall | ${optimized.betNow!=null?(optimized.betNow*100).toFixed(1)+"%":"n/a"} bet-now | cal_err=${optimized.calibrationError}`);

  const improvement=(optimized.overall||0)-(baseline.overall||0);
  const meetsMin  = (optimized.overall||0)>=TARGET_OVERALL_LOW;
  const notOverfit= (optimized.overall||0)<=TARGET_OVERALL_HIGH;
  const betNowOk  = optimized.betNow==null||(optimized.betNow||0)>=TARGET_BET_NOW||workingF.filter(f=>f.edge!=null&&Math.abs(f.edge)>=0.045).length<10;
  const shouldSave= improvement>=MIN_IMPROVEMENT&&meetsMin&&notOverfit;

  if (shouldSave) {
    saveWeights(SIG_W_FILE,optW,{samples:workingF.length,baselineAccuracy:baseline.overall,optimizedAccuracy:optimized.overall,improvement:r4(improvement),betNowAccuracy:optimized.betNow,calibrationError:optimized.calibrationError});
    console.log(`[optimizer] ✓ Saved. Accuracy: ${(baseline.overall*100).toFixed(1)}%→${(optimized.overall*100).toFixed(1)}%`);
    try{require("./stats_model").reloadSignalWeights();}catch{}
  } else {
    const reason=!meetsMin?`Below target (${(optimized.overall*100).toFixed(1)}% < ${(TARGET_OVERALL_LOW*100).toFixed(0)}%)`:!notOverfit?`Possible overfit (${(optimized.overall*100).toFixed(1)}% > ${(TARGET_OVERALL_HIGH*100).toFixed(0)}%)`:`Improvement ${(improvement*100).toFixed(2)}% < min ${(MIN_IMPROVEMENT*100).toFixed(2)}%`;
    console.log(`[optimizer] Not saving: ${reason}`);
  }

  // Top changes
  const changes=Object.fromEntries(Object.keys(optW).map(k=>([k,{from:r4(currentW[k]||0),to:r4(optW[k]),delta:r4((optW[k])-(currentW[k]||0))}])));
  const topMovers=Object.entries(changes).sort((a,b)=>Math.abs(b[1].delta)-Math.abs(a[1].delta)).slice(0,5);
  console.log("[optimizer] Top weight changes:");
  for (const[k,c] of topMovers) console.log(`  ${k.padEnd(22)} ${(c.from*100).toFixed(1)}%→${(c.to*100).toFixed(1)}% (${c.delta>=0?"+":""}${(c.delta*100).toFixed(1)}%)`);

  // Edge bucket accuracy
  console.log("[optimizer] Accuracy by edge:");
  for (const[bk,bv] of Object.entries(optimized.byEdgeBucket)) if(bv.total>=3) console.log(`  ${bk.padEnd(8)} ${bv.accuracy!=null?(bv.accuracy*100).toFixed(1)+"%":"—"} n=${bv.total}`);

  const entry={ran:true,saved:shouldSave,samples:workingF.length,baseline,optimized,improvement:r4(improvement),topChanges:Object.fromEntries(topMovers),finalWeights:shouldSave?optW:currentW,meetsMin,notOverfit};
  saveAudit(entry);
  return entry;
}

function runAccuracyReport(snapshots) {
  const allF=snapshots.map(extractFeatures).filter(Boolean);
  const sigF=allF.filter(f=>f.signals!==null);
  if (!allF.length) return{error:"No graded snapshots"};
  const w=loadWeights(SIG_W_FILE,DEFAULT_W);
  const overall=computeAccuracy(allF,w);
  const byVerdict={};
  for (const f of allF) {
    const v=f.verdict||"unknown"; if(!byVerdict[v])byVerdict[v]=[];
    byVerdict[v].push(f);
  }
  const verdictAcc={};
  for (const[v,vf] of Object.entries(byVerdict)) {
    const a=computeAccuracy(vf,w); verdictAcc[v]={accuracy:a.overall,samples:vf.length,betNow:a.betNow};
  }
  return{overall,verdictAcc,signalSamples:sigF.length,totalSamples:allF.length,currentWeights:w,usingLearned:JSON.stringify(w)!==JSON.stringify(DEFAULT_W)};
}

if (require.main===module) {
  const learning=require("./learning");
  const snaps=learning.getSnapshots();
  if (process.argv.includes("--report")) {
    const r=runAccuracyReport(snaps);
    console.log("\n═══ ACCURACY REPORT ═══");
    console.log(`Overall:  ${r.overall?.overall!=null?(r.overall.overall*100).toFixed(1)+"%":"n/a"}`);
    console.log(`Bet Now:  ${r.overall?.betNow!=null?(r.overall.betNow*100).toFixed(1)+"%":"n/a"}`);
    console.log(`Cal Err:  ${r.overall?.calibrationError??"n/a"}`);
    console.log(`Samples:  ${r.totalSamples} (${r.signalSamples} with signals)`);
    console.log("\nBy verdict:"); for(const[v,a]of Object.entries(r.verdictAcc||{})) console.log(`  ${v.padEnd(12)} ${a.accuracy!=null?(a.accuracy*100).toFixed(1)+"%":"—"} n=${a.samples}`);
    console.log("\nBy edge:"); for(const[b,a]of Object.entries(r.overall?.byEdgeBucket||{})) if(a.total>=3) console.log(`  ${b.padEnd(8)} ${a.accuracy!=null?(a.accuracy*100).toFixed(1)+"%":"—"} n=${a.total}`);
    process.exit(0);
  }
  runSignalOptimizer(snaps).then(r=>{console.log(`\nDone. Saved:${r.saved} Accuracy:${r.optimized?.overall!=null?(r.optimized.overall*100).toFixed(1)+"%":"n/a"}`);process.exit(0);}).catch(e=>{console.error(e);process.exit(1);});
}

module.exports={runSignalOptimizer,runAccuracyReport,computeAccuracy,extractFeatures};
