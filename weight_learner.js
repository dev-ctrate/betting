"use strict";

/**
 * weight_learner.js  v3
 * Learns market-level blend weights via Adam optimizer.
 * Signal weights are handled by signal_optimizer.js (separate, more sophisticated).
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR      = path.join(__dirname, "data");
const MARKET_W_FILE = path.join(DATA_DIR, "learned_weights.json");
const MIN_SAMPLES   = 30;
const LR            = 0.005;
const MAX_EPOCHS    = 3000;
const L2            = 0.08;
const K             = 4.0;

const DEFAULT_WEIGHTS = {
  bias:0.0, market:1.0, spread:1.0, total:1.0,
  lineMove:1.0, disagreement:1.0, statsBlend:0.45, injury:1.0, prop:1.0
};

const BOUNDS = {
  bias:{lo:-1.5,hi:1.5}, market:{lo:0.6,hi:1.8}, spread:{lo:0,hi:6}, total:{lo:0,hi:6},
  lineMove:{lo:0,hi:6}, disagreement:{lo:0,hi:6}, statsBlend:{lo:0,hi:0.85}, injury:{lo:0,hi:6}, prop:{lo:0,hi:6}
};

const sigmoid = x => 1/(1+Math.exp(-Math.max(-50,Math.min(50,x))));
const logit   = p => { const c=Math.max(1e-7,Math.min(1-1e-7,p)); return Math.log(c/(1-c)); };
const clamp   = (x,lo,hi) => Math.max(lo,Math.min(hi,x));

function ensureDir() { if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true}); }

function loadLearnedWeights() {
  try {
    ensureDir();
    if (!fs.existsSync(MARKET_W_FILE)) return{...DEFAULT_WEIGHTS};
    const raw=fs.readFileSync(MARKET_W_FILE,"utf8").trim();
    if (!raw) return{...DEFAULT_WEIGHTS};
    const saved=JSON.parse(raw);
    return{...DEFAULT_WEIGHTS,...(saved.weights||{})};
  } catch { return{...DEFAULT_WEIGHTS}; }
}

function saveLearnedWeights(weights, meta={}) {
  try {
    ensureDir();
    fs.writeFileSync(MARKET_W_FILE,JSON.stringify({weights,meta:{...meta,savedAt:new Date().toISOString(),version:3}},null,2),"utf8");
    return true;
  } catch(e) { console.error("[weight_learner] save failed:",e.message); return false; }
}

function extractFeatures(snap) {
  if (!snap?.result||typeof snap.result.modelWon!=="boolean") return null;
  const mp=Number(snap.impliedProbability);
  if (!Number.isFinite(mp)||mp<=0.01||mp>=0.99) return null;
  const side=snap.pickSide==="home"?1:-1;
  const statsHomeProb=Number(snap.statsModelHomeProb);
  const statsDelta=Number.isFinite(statsHomeProb)?(snap.pickSide==="home"?statsHomeProb:1-statsHomeProb)-mp:0;
  return{
    logitMarket:logit(mp),
    spreadAdj:side*Number(snap.spreadAdj||0),
    totalAdj:side*Number(snap.totalAdj||0),
    lineMoveAdj:side*Number(snap.lineMovementAdj||0),
    disagreement:-Math.abs(Number(snap.disagreementPenalty||0)),
    statsDelta,
    injuryAdj:side*Number(snap.injuryAdjHome||0),
    propAdj:side*Number(snap.propAdj||0),
    won:snap.result.modelWon?1:0
  };
}

function predict(f,w) {
  return sigmoid(w.market*f.logitMarket+w.spread*f.spreadAdj*K+w.total*f.totalAdj*K+
    w.lineMove*f.lineMoveAdj*K+w.disagreement*f.disagreement*K+w.statsBlend*f.statsDelta*K+
    w.injury*f.injuryAdj*K+w.prop*f.propAdj*K+w.bias);
}

function loss(samples,w) {
  const eps=1e-7;
  const ce=samples.reduce((s,f)=>s+(-(f.won*Math.log(predict(f,w)+eps)+(1-f.won)*Math.log(1-predict(f,w)+eps))),0)/samples.length;
  const reg=L2*Object.keys(DEFAULT_WEIGHTS).reduce((s,k)=>s+(w[k]-DEFAULT_WEIGHTS[k])**2,0)/samples.length;
  return ce+reg;
}

function grad(samples,w,eps=1e-5) {
  const base=loss(samples,w),g={};
  for (const k of Object.keys(w)){const wp={...w,[k]:w[k]+eps};g[k]=(loss(samples,wp)-base)/eps;}
  return g;
}

async function runWeightLearning(snapshots) {
  console.log(`[weight_learner] Starting on ${snapshots.length} snapshots`);
  const features=snapshots.map(extractFeatures).filter(Boolean);
  console.log(`[weight_learner] Valid features: ${features.length}`);

  if (features.length<MIN_SAMPLES) return{weights:DEFAULT_WEIGHTS,improved:false,samples:features.length};

  let w={...loadLearnedWeights()};
  const initLoss=loss(features,w);
  let prevLoss=initLoss;
  const m=Object.fromEntries(Object.keys(w).map(k=>[k,0]));
  const v=Object.fromEntries(Object.keys(w).map(k=>[k,0]));
  const b1=0.9,b2=0.999,ea=1e-8;
  let t=0,stalled=0;

  for (let ep=0;ep<MAX_EPOCHS;ep++) {
    t++;
    const g=grad(features,w);
    for (const k of Object.keys(w)) {
      m[k]=b1*m[k]+(1-b1)*g[k]; v[k]=b2*v[k]+(1-b2)*g[k]**2;
      const mh=m[k]/(1-b1**t),vh=v[k]/(1-b2**t);
      w[k]-=(LR*mh/(Math.sqrt(vh)+ea));
      const b=BOUNDS[k]; if(b) w[k]=clamp(w[k],b.lo,b.hi);
    }
    const cl=loss(features,w);
    if (Math.abs(prevLoss-cl)<1e-7){stalled++;if(stalled>60){console.log(`[weight_learner] Converged ep${ep+1}`);break;}}
    else stalled=0;
    prevLoss=cl;
  }

  const finalLoss=loss(features,w);
  const improved=finalLoss<initLoss-1e-4;
  let correct=0;
  for (const f of features){const p=predict(f,w);if((p>=0.5)===(f.won===1))correct++;}
  const accuracy=correct/features.length;

  console.log(`[weight_learner] Loss: ${initLoss.toFixed(4)}→${finalLoss.toFixed(4)} | Acc: ${(accuracy*100).toFixed(1)}%`);

  if (improved||features.length>=150) {
    saveLearnedWeights(w,{samples:features.length,finalLoss,initialLoss:initLoss,accuracy});
    console.log("[weight_learner] Market weights saved");
  }

  return{weights:w,finalLoss,initialLoss:initLoss,improved,samples:features.length,marketResult:{improved,finalLoss,initialLoss:initLoss},signalResult:{improved:false,samples:0}};
}

function applyLearnedWeights({marketProb,pickSide,modelDetails,statsHomeProb,weights}) {
  const w=weights||DEFAULT_WEIGHTS;
  const side=pickSide==="home"?1:-1;
  let statsDelta=0;
  if (typeof statsHomeProb==="number"&&Number.isFinite(statsHomeProb)) {
    const spp=pickSide==="home"?statsHomeProb:1-statsHomeProb;
    statsDelta=spp-marketProb;
  }
  const safeMarket=Math.max(0.01,Math.min(0.99,marketProb));
  const lp=w.market*logit(safeMarket)+w.spread*side*Number(modelDetails?.spreadAdj||0)*K+
    w.total*side*Number(modelDetails?.totalAdj||0)*K+w.lineMove*side*Number(modelDetails?.lineMovementAdj||0)*K+
    w.disagreement*-Math.abs(Number(modelDetails?.disagreementPenalty||0))*K+w.statsBlend*statsDelta*K+
    w.injury*side*Number(modelDetails?.injuryAdjHome||0)*K+w.prop*side*Number(modelDetails?.propAdj||0)*K+w.bias;
  return clamp(sigmoid(lp),0.01,0.99);
}

if (require.main===module) {
  const learning=require("./learning");
  runWeightLearning(learning.getSnapshots()).then(r=>{
    console.log(`Done. Improved:${r.improved}`);process.exit(0);
  }).catch(e=>{console.error(e);process.exit(1);});
}

module.exports={runWeightLearning,loadLearnedWeights,applyLearnedWeights,DEFAULT_WEIGHTS};
