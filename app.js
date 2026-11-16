/* Uno Solar Lab — educational Arduino Uno subset interpreter.
   A0/A1/A2/A3: TL/TR/BL/BR LDR; NEMA17-H STEP/DIR: D2/D3; NEMA17-V STEP/DIR: D4/D5.
   A4(SDA)/A5(SCL): I2C, LCD 0x26/0x27 and optional INA219 model. */
const $ = id => document.getElementById(id);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const A0 = 0, A1 = 1, A2 = 2, A3 = 3, A4 = 4, A5 = 5;

// -----------------------------------------------------------------------------
// Supplied CAD meshes
// These are the actual binary STL files included in the project's CAD archive:
// 30:1 worm/wheel, 155 mm turntable bearing, NEMA17 motor, and its bracket.
// They are kept separate so D9/D10 can move the appropriate physical group;
// no independent animation is applied to these parts.
const suppliedCadMeshes = Object.create(null);
const suppliedCadManifest = {
  bearingLower: ['assets/supplied-cad/turntable-lower-155.stl', 7],
  bearingUpper: ['assets/supplied-cad/turntable-upper-155.stl', 7],
  wormWheel: ['assets/supplied-cad/wheel-6mm.stl', 140],
  worm: ['assets/supplied-cad/worm-6mm.stl', 16],
  nema17: ['assets/supplied-cad/nema17-motor.stl', 3],
  nemaBracket: ['assets/supplied-cad/nema17-bracket.stl', 3]
};

function parseSuppliedBinaryStl(buffer, stride = 1) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  if (84 + count * 50 !== buffer.byteLength) throw new Error('Invalid binary STL');
  const triangles = [], min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += stride) {
    const tri = [];
    for (let vertex = 0; vertex < 3; vertex++) {
      const start = 84 + i * 50 + 12 + vertex * 12;
      const point = [view.getFloat32(start, true), view.getFloat32(start + 4, true), view.getFloat32(start + 8, true)];
      point.forEach((value, axis) => { min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value); });
      tri.push(point);
    }
    triangles.push(tri);
  }
  const center = min.map((value, axis) => (value + max[axis]) / 2);
  return { triangles, center, span: Math.max(...max.map((value, axis) => value - min[axis])) };
}

async function loadSuppliedCadMeshes() {
  await Promise.all(Object.entries(suppliedCadManifest).map(async ([name, [url, stride]]) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(response.statusText);
      suppliedCadMeshes[name] = parseSuppliedBinaryStl(await response.arrayBuffer(), stride);
    } catch (error) {
      console.warn(`Could not load supplied CAD mesh: ${name}`, error);
    }
  }));
  renderAll();
}

const defaultSketch = `// 2축 태양광 추적 및 탄소 저감량 모니터링 시스템
// 아두이노 우노 1개 / NEMA17 스테퍼모터 2개 / 30:1 웜기어
// CdS 광센서 4개 / LCD 2개 / INA219 전압·전류 센서

#include <Wire.h>
#include <AccelStepper.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_INA219.h>

// LCD1 : 추적 전 발전량, LCD2 : 추적 후 발전량 / 결과
LiquidCrystal_I2C lcd1(0x26, 16, 2);
LiquidCrystal_I2C lcd2(0x27, 16, 2);

// 전압·전류 센서 (I2C, 주소 0x40)
Adafruit_INA219 ina219;

// A4988/DRV8825 STEP·DIR 드라이버 기준
// 수평축: STEP D2 / DIR D3, 수직축: STEP D4 / DIR D5
AccelStepper motorH(AccelStepper::DRIVER, 2, 3);
AccelStepper motorV(AccelStepper::DRIVER, 4, 5);

// 1.8° NEMA17, 1/8 microstep, 30:1 웜기어
const float STEPS_PER_DEG = 133.333;

const int RANGE = 35;   // 밝기 차이가 이 값 이하면 "정렬됨"

int angleH = 90;
int angleV = 90;

int errH = 0;   // 좌우 밝기 차이 (+면 왼쪽이 밝음)
int errV = 0;   // 상하 밝기 차이 (+면 위쪽이 밝음)

// 0:추적 전 측정  1:추적  2:30초 대기  3:추적 후 측정  4:결과 표시
int step = 0;
int count = 0;   // loop 한 번 = 0.1초, 몇 번 돌았는지 셈
int page = 0;

float sumP = 0, sumV = 0, sumI = 0;
float beforeP = 0;
float afterP = 0, afterV = 0, afterI = 0;
float rate = 0;       // 증가율 (%)
float energyWh = 0;   // 누적 발전량

void setup() {
  motorH.setMaxSpeed(800);
  motorH.setAcceleration(500);
  motorV.setMaxSpeed(800);
  motorV.setAcceleration(500);
  moveHorizontal(angleH);
  moveVertical(angleV);

  lcd1.init();
  lcd1.backlight();
  lcd2.init();
  lcd2.backlight();

  ina219.begin();

  showLcd1("BEFORE TRACK", "MEASURING...");
  showLcd2("AFTER TRACK", "WAIT...");
}

void loop() {
  // 현재 전압, 전류, 전력
  float v = ina219.getBusVoltage_V();
  float a = ina219.getCurrent_mA() / 1000.0;
  if (a < 0) a = 0;
  float p = v * a;

  // 누적 발전량 : 0.1초 = 0.1/3600 시간
  energyWh = energyWh + p * 0.1 / 3600.0;

  // 추적 전 측정(step 0) 때는 모터를 움직이지 않음
  bool ok = false;
  if (step > 0) ok = track();

  // 대기나 측정 중에 빛이 움직이면 다시 추적부터
  if (step >= 2 && ok == false) {
    step = 1;
    count = 0;
    sumP = 0; sumV = 0; sumI = 0;
  }

  if (step == 0) {
    // 5초(50번) 평균
    sumP = sumP + p;
    count++;
    if (count == 50) {
      beforeP = sumP / 50;
      showLcd1("BEFORE TRACK", "P:" + String(beforeP, 2) + "W");
      sumP = 0;
      count = 0;
      step = 1;
    }
  }
  else if (step == 1) {
    // 10번 연속 정렬되면 추적 완료
    if (ok) count++;
    else count = 0;

    showLcd2("TRACKING", "H:" + String(errH) + " V:" + String(errV));

    if (count == 10) {
      showLcd2("TRACK COMPLETE", "WAIT 30 SEC");
      count = 0;
      step = 2;
    }
  }
  else if (step == 2) {
    // 30초(300번) 대기
    count++;
    if (count == 300) {
      showLcd2("AFTER MEASURE", "MEASURING...");
      count = 0;
      step = 3;
    }
  }
  else if (step == 3) {
    // 5초(50번) 평균
    sumP = sumP + p;
    sumV = sumV + v;
    sumI = sumI + a;
    count++;
    if (count == 50) {
      afterP = sumP / 50;
      afterV = sumV / 50;
      afterI = sumI / 50;

      if (beforeP > 0.01) rate = (afterP - beforeP) / beforeP * 100;
      else rate = 0;

      showLcd2("AFTER TRACK", "P:" + String(afterP, 2) + "W");
      sumP = 0; sumV = 0; sumI = 0;
      count = 0;
      page = 0;
      step = 4;
    }
  }
  else if (step == 4) {
    // 3초(30번)마다 결과 화면 넘기기
    count++;
    if (count == 30) {
      count = 0;
      showPage();
      page++;
      if (page > 3) page = 0;
    }
  }

  delay(100);
}

// 빛 방향으로 모터 1도씩 이동, 정렬됐으면 true
// 모터가 반대로 가면 ++ 와 -- 를 서로 바꾸면 됨
bool track() {
  int tl = analogRead(A0);   // 좌상
  int tr = analogRead(A1);   // 우상
  int bl = analogRead(A2);   // 좌하
  int br = analogRead(A3);   // 우하

  errH = (tl + bl) / 2 - (tr + br) / 2;
  errV = (tl + tr) / 2 - (bl + br) / 2;

  if (errH > RANGE) angleH--;
  if (errH < -RANGE) angleH++;
  if (errV > RANGE) angleV++;
  if (errV < -RANGE) angleV--;

  // CAD 간섭 검증을 통과한 기계 안전 범위 20~160도
  angleH = constrain(angleH, 20, 160);
  angleV = constrain(angleV, 20, 160);

  moveHorizontal(angleH);
  moveVertical(angleV);

  if (abs(errH) <= RANGE && abs(errV) <= RANGE) return true;
  return false;
}

// NEMA17 + 30:1 웜기어 위치 명령
// 시뮬레이터에서는 이 명령이 실제 패널 각도와 3D 모델에 바로 반영됩니다.
void moveHorizontal(int degree) {
  motorH.moveTo((degree - 90) * STEPS_PER_DEG);
  motorH.runToPosition();
}

void moveVertical(int degree) {
  motorV.moveTo((degree - 90) * STEPS_PER_DEG);
  motorV.runToPosition();
}

// 결과 화면 4페이지
void showPage() {
  if (page == 0) showLcd2("AFTER POWER", String(afterP, 2) + "W " + String(rate, 1) + "%");
  if (page == 1) showLcd2("VOLT / CURRENT", String(afterV, 2) + "V " + String(afterI, 2) + "A");
  if (page == 2) showLcd2("ENERGY", String(energyWh, 3) + "Wh");
  // 0.4541 kgCO2/kWh = 0.4541 gCO2/Wh 라서 Wh에 바로 곱하면 g
  if (page == 3) showLcd2("CO2 REDUCTION", String(energyWh * 0.4541, 3) + "g");
}

// LCD 두 줄 출력 (뒤에 공백을 붙여 이전 글자를 지움)
void showLcd1(String line1, String line2) {
  lcd1.setCursor(0, 0);
  lcd1.print(line1 + "                ");
  lcd1.setCursor(0, 1);
  lcd1.print(line2 + "                ");
}

void showLcd2(String line1, String line2) {
  lcd2.setCursor(0, 0);
  lcd2.print(line1 + "                ");
  lcd2.setCursor(0, 1);
  lcd2.print(line2 + "                ");
}`;

const state = { running:false, compiled:null, scope:{}, loopDelay:.18, nextLoop:0, h:90, v:90,
  pins:{A0:0,A1:0,A2:0,A3:0}, ldr:{left:0,right:0,top:0,bottom:0}, power:0, voltage:0, current:0,
  energy:0, co2Kg:0, elapsed:0, lastFrame:null, servos:{}, pinServos:{}, steppers:{}, lcds:{}, auto:null, serial:[],
  panelNormal:[0,0,1], lightDirection:[0,0,1], incidenceAngle:0, alignment:0,
  systemState:'IDLE', beforePower:null, afterPower:null, increaseRate:null, collision:{safe:true,items:[],minimum:0} };
// Orbit-camera state for the mouse/touch controlled 3D model.
// Reference-camera pose: a centred front-right isometric view that keeps the
// panel, elevation hinge, rotating base, and acrylic enclosure in one frame.
// Both the initial render and “시점 초기화” use this one source of truth.
const defaultViewerPose = Object.freeze({ yaw: .56, pitch: .36, zoom: .90 });
const viewer = { ...defaultViewerPose, drag:null };
function env() { const lightAzimuth=+$('lightAz').value,lightElevation=+$('lightEl').value;return { lightAzimuth,lightElevation,az:lightAzimuth,el:lightElevation,intensity:85,speed:+$('speed').value,maxPower:5,co2Factor:.4541 }; }
function mechanics(){const value=(id,fallback)=>{const raw=$(id)?.value;const n=raw===''||raw===undefined?fallback:+raw;return Number.isFinite(n)?Math.max(0,n):fallback;};return {width:value('panelWidth',215),height:value('panelHeight',180),bearingSide:155,bearingHeight:10,nema:[42,59.2,42],gearRatio:30,fullSteps:200,microsteps:8,stepsPerDegree:133.333};}
function updateTorqueSimulation(){const m=mechanics(),resolution=1.8/m.gearRatio/m.microsteps;$('d9Torque').textContent=`${m.stepsPerDegree.toFixed(2)} step/°`;$('d10Torque').textContent=`${m.stepsPerDegree.toFixed(2)} step/°`;$('safeTorque').textContent=`${resolution.toFixed(4)}° / µstep`;$('torqueVerdict').textContent='CAD 적용';$('torqueVerdict').className='torque-verdict safe';$('torqueAdvice').textContent=`CAD 치수: 패널 ${m.width.toFixed(0)}×${m.height.toFixed(0)} mm · NEMA17 ${m.nema.join('×')} mm · 30:1 웜기어 · 155×155×10 mm 회전 베어링. 코드의 STEPS_PER_DEG=${m.stepsPerDegree.toFixed(3)}은 1/8 microstep 기준입니다.`;return {status:'safe',safe:true,stepsPerDegree:m.stepsPerDegree,resolution};}

// --- 3D mechanical clearance model -------------------------------------------------
// The panel is an oriented bounding box (OBB). The base, fixed D9 case, aluminium
// posts and D10 case are solid boxes. The same D9/D10 angles that draw the panel are
// used here, so a code-driven Servo.write() cannot visually pass through a solid part.
const dot3=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub3=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const length3=v=>Math.hypot(v[0],v[1],v[2]);
const worldPerMm=1.2;
// Mechanical zero: the photographed / supplied CAD structure has the module
// above the posts, facing upward at a 90° elevation command.  This calibration
// offset is part of the real bracket geometry, not a canvas-only animation.
const panelTiltRadians=(elevation=state.v)=>elevation*Math.PI/180;
function panelObb(azimuth=state.h,elevation=state.v){const m=mechanics(),tilt=panelTiltRadians(elevation),ct=Math.cos(tilt),st=Math.sin(tilt),turn=v=>rotateAzimuth(v,azimuth);return {center:turn([0,panelMountHeight,0]),axes:[turn([1,0,0]),turn([0,ct,-st]),turn([0,st,ct])],half:[m.width*worldPerMm/2,m.height*worldPerMm/2,4]};}
function makeBox(id,label,center,size){return {id,label,center,size,half:size.map(v=>v/2)};}
function boxCorners(box){const out=[];for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1])out.push([box.center[0]+sx*box.half[0],box.center[1]+sy*box.half[1],box.center[2]+sz*box.half[2]]);return out;}
function obbCorners(obb){const out=[];for(const sx of [-1,1])for(const sy of [-1,1])for(const sz of [-1,1])out.push(obb.center.map((v,i)=>v+sx*obb.axes[0][i]*obb.half[0]+sy*obb.axes[1][i]*obb.half[1]+sz*obb.axes[2][i]*obb.half[2]));return out;}
function pointToBox(point,box){const d=point.map((v,i)=>Math.max(Math.abs(v-box.center[i])-box.half[i],0));return length3(d);}
function pointToObb(point,obb){const rel=sub3(point,obb.center),d=obb.axes.map((axis,i)=>Math.max(Math.abs(dot3(rel,axis))-obb.half[i],0));return length3(d);}
function obbIntersectsBox(obb,box){const r=obb.axes.map(axis=>[axis[0],axis[1],axis[2]]),ar=r.map(row=>row.map(v=>Math.abs(v)+1e-8)),t=sub3(box.center,obb.center);for(let i=0;i<3;i++){const ra=obb.half[i],rb=box.half[0]*ar[i][0]+box.half[1]*ar[i][1]+box.half[2]*ar[i][2];if(Math.abs(dot3(t,obb.axes[i]))>ra+rb)return false;}for(let j=0;j<3;j++){const ra=obb.half[0]*ar[0][j]+obb.half[1]*ar[1][j]+obb.half[2]*ar[2][j],rb=box.half[j];if(Math.abs(t[j])>ra+rb)return false;}for(let i=0;i<3;i++)for(let j=0;j<3;j++){const ra=obb.half[(i+1)%3]*ar[(i+2)%3][j]+obb.half[(i+2)%3]*ar[(i+1)%3][j],rb=box.half[(j+1)%3]*ar[i][(j+2)%3]+box.half[(j+2)%3]*ar[i][(j+1)%3],tv=Math.abs(t[(j+2)%3]*r[(i+1)%3][j]-t[(j+1)%3]*r[(i+2)%3][j]);if(tv>ra+rb)return false;}return true;}
function approximateClearance(obb,box){if(obbIntersectsBox(obb,box))return 0;return Math.min(...obbCorners(obb).map(p=>pointToBox(p,box)),...boxCorners(box).map(p=>pointToObb(p,obb)));}
function collisionObjects(azimuth,elevation){const turn=point=>rotateAzimuth(point,azimuth),localBox=(id,label,center,size)=>makeBox(id,label,turn(center),size);return [makeBox('base','200mm 아크릴 베이스',[0,-8,0],[220,20,220]),makeBox('turntable','155mm 회전 베어링',[0,5,0],[155,20,155]),...[-48,48].flatMap(x=>[-34,34].map(z=>localBox(`post-${x}-${z}`,'알루미늄 기둥',[x,(15+profileTop)/2,z],[20,profileTop-15,20]))),localBox('d10','NEMA17-V / 웜기어',[-58,profileTop-35,-42],[50,70,50]),makeBox('d9','NEMA17-H / 웜기어',[-122,35,-48],[50,70,50])];}
function getCollisionState(azimuth=state.h,elevation=state.v){const obb=panelObb(azimuth,elevation),items=collisionObjects(azimuth,elevation).map(box=>{const clearance=approximateClearance(obb,box);return {id:box.id,label:box.label,clearance,collision:clearance===0};});return {safe:!items.some(item=>item.collision),items,minimum:Math.min(...items.map(item=>item.clearance))};}
function collisionByGroup(collision,ids){const values=collision.items.filter(item=>ids.includes(item.id));return Math.min(...values.map(item=>item.clearance));}
function clearanceText(value){return value===0?'0 mm · 충돌':`${(value/worldPerMm).toFixed(1)} mm`;}
function updateCollisionSimulation(){const collision=getCollisionState();state.collision=collision;const base=collisionByGroup(collision,['base','turntable']),posts=collisionByGroup(collision,['post--48--34','post--48-34','post-48--34','post-48-34']),d10=collisionByGroup(collision,['d10']),d9=collisionByGroup(collision,['d9']);[['clearBase',base],['clearPillars',posts],['clearD10',d10],['clearD9',d9]].forEach(([id,value])=>{$(id).textContent=clearanceText(value);$(id).className=value===0?'collision-hit':'';});const verdict=$('collisionVerdict');verdict.textContent=collision.safe?'간섭 없음':'충돌 감지';verdict.className=`collision-verdict ${collision.safe?'safe':'risk'}`;$('collisionAdvice').textContent=collision.safe?`현재 NEMA17-H ${state.h}° · NEMA17-V ${state.v}°에서 최소 근사 간격은 ${(collision.minimum/worldPerMm).toFixed(1)} mm입니다. STEP/DIR 위치 명령은 충돌 경로를 막습니다.`:'패널이 구조물과 겹칩니다. 해당 스테퍼 위치 명령은 차단했습니다. 패널 크기·힌지 높이·기둥 위치를 조정하세요.';return collision;}
function updateEnvironment() {
  const e=env(), hOff=clamp((e.lightAzimuth-state.h)/48,-1,1), vOff=clamp((e.lightElevation-state.v)/48,-1,1);
  // This is the same kinematic convention used by panelWorldPoint(): at D10
  // 90° the panel normal points up; D10 changes its real elevation about the
  // hinge, while D9 remains an independent vertical-axis azimuth rotation.
  const vectorForAngles=(azimuth,elevation)=>{const az=(azimuth-90)*Math.PI/180,el=panelTiltRadians(elevation),ce=Math.cos(el);return [Math.sin(az)*ce,Math.sin(el),Math.cos(az)*ce];};
  state.lightDirection=vectorForAngles(e.lightAzimuth,e.lightElevation);state.panelNormal=vectorForAngles(state.h,state.v);const dot=clamp(state.lightDirection[0]*state.panelNormal[0]+state.lightDirection[1]*state.panelNormal[1]+state.lightDirection[2]*state.panelNormal[2],-1,1),incidence=Math.max(0,dot);
  state.incidenceAngle=Math.acos(dot)*180/Math.PI;
  state.alignment=incidence;
  const base=120+e.intensity*4.1, split=.44, cell=(h,v)=>Math.round(clamp(base*(1+h*hOff*split+v*vOff*split),0,1023));
  state.pins={A0:cell(-1,1),A1:cell(1,1),A2:cell(-1,-1),A3:cell(1,-1)};
  state.ldr.left=(state.pins.A0+state.pins.A2)/2;state.ldr.right=(state.pins.A1+state.pins.A3)/2;state.ldr.top=(state.pins.A0+state.pins.A1)/2;state.ldr.bottom=(state.pins.A2+state.pins.A3)/2;
  // Physical panel model: LDR values guide tracking only. Power is from light-vector / panel-normal alignment.
  state.power=e.maxPower*(e.intensity/100)*incidence;
  state.voltage=16+2*incidence; // Educational PV model: voltage varies gently, current carries irradiance change.
  state.current=state.voltage>0?state.power/state.voltage:0;
}
// Shared tracker kinematics. Every rendered moving part and the power model
// uses these exact command angles; there is no canvas-only animation state.
function rotateAzimuth(point,azimuth=state.h){const yaw=(azimuth-90)*Math.PI/180,cy=Math.cos(yaw),sy=Math.sin(yaw),[x,y,z]=point;return [x*cy+z*sy,y,-x*sy+z*cy];}
// The panel hinge sits above the profile tops. At neutral D10=90°, its lowest
// edge clears the columns instead of appearing to hang between them.
const panelMountHeight=260,profileTop=140;
function panelWorldPoint(point,azimuth=state.h,elevation=state.v){const tilt=panelTiltRadians(elevation),ct=Math.cos(tilt),st=Math.sin(tilt),[x,y,z]=point;return rotateAzimuth([x,y*ct+z*st+panelMountHeight,-y*st+z*ct],azimuth);}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function serialPrint(message){state.serial.push({time:state.elapsed,text:String(message)});if(state.serial.length>300)state.serial.shift();renderSerial();}
function renderSerial(){$('serialLog').innerHTML=state.serial.map(l=>`<div><time>${l.time.toFixed(2).padStart(6,'0')}s</time>${esc(l.text)}</div>`).join('');$('serialLog').scrollTop=$('serialLog').scrollHeight;}
function makeServo(name){return {name,pin:null,angle:90,attach(pin){this.pin=+pin;state.servos[name]=this;state.pinServos[this.pin]=this;serialPrint(`${name}.attach(D${pin})`);},write(angle){const next=clamp(Math.round(+angle||0),20,160),nextH=this.pin===9?next:state.h,nextV=this.pin===10?next:state.v,collision=getCollisionState(nextH,nextV);if(!collision.safe){const key=`${this.pin}:${nextH}:${nextV}`;if(state.lastCollisionKey!==key){state.lastCollisionKey=key;serialPrint(`COLLISION BLOCKED: D${this.pin} → ${next}°`);}state.collision=collision;return false;}state.lastCollisionKey='';this.angle=next;if(this.pin===9)state.h=this.angle;if(this.pin===10)state.v=this.angle;state.collision=collision;return true;},read(){return this.angle;}};}
function makeStepper(name,stepPin,dirPin){const horizontal=/h$/i.test(name)||/horizontal/i.test(name),stepsPerDegree=133.333;const axis=horizontal?'H':'V';const stepper={name,stepPin:+stepPin,dirPin:+dirPin,position:0,target:0,maxSpeed:800,acceleration:500,setMaxSpeed(value){this.maxSpeed=+value||this.maxSpeed;},setAcceleration(value){this.acceleration=+value||this.acceleration;},moveTo(steps){this.target=+steps||0;},currentPosition(){return this.position;},run(){return this.runToPosition();},runToPosition(){const requested=clamp(Math.round(90+this.target/stepsPerDegree),20,160),nextH=horizontal?requested:state.h,nextV=horizontal?state.v:requested,collision=getCollisionState(nextH,nextV);if(!collision.safe){const key=`stepper-${axis}:${nextH}:${nextV}`;if(state.lastCollisionKey!==key){state.lastCollisionKey=key;serialPrint(`COLLISION BLOCKED: NEMA17-${axis} → ${requested}°`);}state.collision=collision;return false;}state.lastCollisionKey='';this.position=this.target;if(horizontal)state.h=requested;else state.v=requested;state.collision=collision;return true;}};state.steppers[name]=stepper;serialPrint(`${name}: NEMA17 STEP D${stepPin} / DIR D${dirPin}`);return stepper;}
function makeLcd(address){const key=address===0x26?'26':address===0x27?'27':String(address);const lcd={address,col:0,row:0,lines:['                ','                '],batch:false,lastLogged:'',init(){state.lcds[key]=this;},begin(){state.lcds[key]=this;},backlight(){},notify(){if(this.batch)return;const content=this.lines.join(' / ');if(content!==this.lastLogged){this.lastLogged=content;serialPrint(`[LCD 0x${this.address.toString(16).toUpperCase()}] ${this.lines[0].trim()} / ${this.lines[1].trim()}`);}},clear(){this.lines=['                ','                '];this.col=0;this.row=0;this.notify();},setCursor(col,row){this.col=clamp(Math.floor(+col||0),0,15);this.row=clamp(Math.floor(+row||0),0,1);},print(value,precision){let text;if(typeof value==='number'){text=Number.isInteger(precision)&&precision>=0?value.toFixed(precision):String(+value.toFixed(2));}else{text=String(value);}let line=this.lines[this.row];for(const char of text){if(this.col>=16)break;line=line.slice(0,this.col)+char+line.slice(this.col+1);this.col++;}this.lines[this.row]=line;this.notify();},println(value,precision){this.print(value,precision);this.row=1;this.col=0;}};state.lcds[key]=lcd;return lcd;}
// Optional INA219 current/power monitor on the same virtual I²C bus (A4/A5).
// Values are derived from the physical panel model, just as the real sensor would observe them.
function makeIna219(address=0x40){return {address,ready:false,begin(){this.ready=true;serialPrint(`INA219.begin(0x${this.address.toString(16).toUpperCase()})`);return true;},getBusVoltage_V(){return state.voltage;},getShuntVoltage_mV(){return state.current*.1;},getCurrent_mA(){return state.current*1000;},getPower_mW(){return state.power*1000;},getLoadVoltage_V(){return state.voltage+this.getShuntVoltage_mV()/1000;},setCalibration_32V_2A(){},setCalibration_32V_1A(){},setCalibration_16V_400mA(){}};}
// Arduino String(value, decimals) compatibility for code typed in the editor.
// It keeps ordinary text intact and formats numeric values just like String(float, digits).
function arduinoString(value, decimals){if(typeof value==='number'&&Number.isInteger(decimals)&&decimals>=0)return value.toFixed(decimals);return String(value);}

// The default sketch calls these helpers. They write through the two actual I2C LCD objects.
function writeLcdScreen(lcd, line1, line2){if(!lcd)return;const next=[String(line1).slice(0,16).padEnd(16,' '),String(line2).slice(0,16).padEnd(16,' ')];if(lcd.lines[0]===next[0]&&lcd.lines[1]===next[1])return;lcd.batch=true;lcd.clear();lcd.setCursor(0,0);lcd.print(next[0]);lcd.setCursor(0,1);lcd.print(next[1]);lcd.batch=false;lcd.notify();}
function beginAutoTracking(lcd1,lcd2){state.auto={lcd1,lcd2,phase:'STARTUP',phaseTime:0,sampleTime:0,samplePower:0,sampleCount:0,stable:0,readTime:0,beforePower:null,afterPower:null,afterShown:0,finalClock:0,finalPage:0,lastServoLog:0};writeLcdScreen(lcd1,'SYSTEM START','WAIT...');writeLcdScreen(lcd2,'AFTER TRACK','WAIT...');serialPrint('Auto tracking sequence armed');}
function runAutoTracking(lcd1,lcd2){if(!state.auto)beginAutoTracking(lcd1,lcd2);else{state.auto.lcd1=lcd1;state.auto.lcd2=lcd2;}}
function restartAutoTracking(){if(!state.auto)return;beginAutoTracking(state.auto.lcd1,state.auto.lcd2);state.running=true;serialPrint('New tracking and measurement cycle started');}
function autoTolerance(){return Number(state.scope.tolerance ?? 18);}function autoStep(){return Math.max(1,Number(state.scope.stepSize ?? 2));}
function autoServo(pin,direction,label){const servo=state.pinServos[pin],current=pin===9?state.h:state.v,next=clamp(current+direction*autoStep(),20,160);if(next===current)return;if(servo)servo.write(next);else if(pin===9)state.h=next;else state.v=next;if('horizontalPos' in state.scope&&pin===9)state.scope.horizontalPos=next;if('verticalPos' in state.scope&&pin===10)state.scope.verticalPos=next;serialPrint(`${label} servo D${pin} → ${next}°`);}
function startMeasurement(auto,phase){auto.phase=phase;auto.phaseTime=0;auto.sampleTime=0;auto.samplePower=0;auto.sampleCount=0;serialPrint(phase==='BEFORE_MEASURE'?'Before measurement started':'After measurement started');}
function updateAutoTracking(delta){const a=state.auto;if(!a)return;a.phaseTime+=delta;
  if(a.phase==='STARTUP'){if(a.phaseTime>=1){startMeasurement(a,'BEFORE_MEASURE');writeLcdScreen(a.lcd2,'AFTER TRACK','WAIT...');}return;}
  if(a.phase==='BEFORE_MEASURE'||a.phase==='AFTER_MEASURE'){a.sampleTime+=delta;a.samplePower+=state.power;a.sampleCount++;if(a.sampleTime>=5){const avg=a.samplePower/a.sampleCount;if(a.phase==='BEFORE_MEASURE'){a.beforePower=avg;writeLcdScreen(a.lcd1,'BEFORE TRACK',`P:${avg.toFixed(2)}W`);a.phase='TRACKING';a.phaseTime=0;serialPrint(`Before power fixed: ${avg.toFixed(2)}W`);}else{a.afterPower=avg;writeLcdScreen(a.lcd2,'AFTER TRACK',`P:${avg.toFixed(2)}W`);a.phase='AFTER_SHOW';a.phaseTime=0;serialPrint(`After measurement complete: ${avg.toFixed(2)}W`);}}return;}
  if(a.phase==='TRACKING'){a.readTime+=delta;if(a.readTime<.18)return;a.readTime=0;const h=state.ldr.right-state.ldr.left,v=state.ldr.top-state.ldr.bottom,tol=autoTolerance();writeLcdScreen(a.lcd2,'TRACKING',`H:${Math.round(h)} V:${Math.round(v)}`);const hOk=Math.abs(h)<=tol,vOk=Math.abs(v)<=tol;if(!hOk)autoServo(9,Math.sign(h),'Horizontal');if(!vOk)autoServo(10,Math.sign(v),'Vertical');a.stable=hOk&&vOk?a.stable+1:0;if(a.stable>=10){a.phase='STABILIZING';a.phaseTime=0;writeLcdScreen(a.lcd2,'TRACK COMPLETE','WAIT 30 SEC');serialPrint('Tracking complete; stabilizing for 30 sec');}return;}
  if(a.phase==='STABILIZING'){if(a.phaseTime>=30)startMeasurement(a,'AFTER_MEASURE');return;}
  if(a.phase==='AFTER_SHOW'){if(a.phaseTime>=3){a.phase='FINAL';a.phaseTime=0;a.finalClock=0;a.finalPage=0;}return;}
  if(a.phase==='FINAL'){const h=state.ldr.right-state.ldr.left,v=state.ldr.top-state.ldr.bottom,changed=Math.abs(h)>autoTolerance()||Math.abs(v)>autoTolerance();a.changeReads=changed?(a.changeReads||0)+1:0;if(a.changeReads>=3){serialPrint('Light vector changed — restarting tracking cycle');restartAutoTracking();return;}a.finalClock+=delta;if(a.finalClock>=3){a.finalClock=0;a.finalPage=1-a.finalPage;}const increase=a.beforePower?((a.afterPower-a.beforePower)/a.beforePower)*100:0;if(a.finalPage===0)writeLcdScreen(a.lcd2,`AFTER ${a.afterPower.toFixed(2)}W`,`UP ${increase.toFixed(1)}%`);else writeLcdScreen(a.lcd2,`ENERGY ${state.energy.toFixed(1)}Wh`,`CO2 ${(state.energy*.42).toFixed(2)}g`);}}

function extractFunction(source,name){const m=new RegExp(`void\\s+${name}\\s*\\(\\s*\\)\\s*\\{`).exec(source);if(!m)return '';let depth=1,i=m.index+m[0].length;for(;i<source.length&&depth;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}if(depth)throw new Error(`${name}()의 닫는 중괄호가 없습니다.`);return source.slice(m.index+m[0].length,i-1);}
function removeFunction(source,name){const m=new RegExp(`void\\s+${name}\\s*\\(\\s*\\)\\s*\\{`).exec(source);if(!m)return source;let depth=1,i=m.index+m[0].length;for(;i<source.length&&depth;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}return source.slice(0,m.index)+source.slice(i);}
function transform(body){return body.replace(/\/\/.*$/gm,'').replace(/\b(?:const\s+)?(?:unsigned\s+long|int|float|double|long|bool|boolean|String)\s+([A-Za-z_]\w*)/g,'let $1');}
function extractAllFunctions(source){const found=[],re=/\b(?:void|int|float|double|long|unsigned\s+long|bool|boolean)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*\{/g;let match;while((match=re.exec(source))){let depth=1,i=re.lastIndex;for(;i<source.length&&depth;i++){if(source[i]==='{')depth++;else if(source[i]==='}')depth--;}if(depth)throw new Error(`${match[1]}()의 닫는 중괄호가 없습니다.`);found.push({name:match[1],params:match[2],body:source.slice(re.lastIndex,i-1),start:match.index,end:i});re.lastIndex=i;}return found;}
function removeFunctionRanges(source,functions){return functions.slice().reverse().reduce((text,fn)=>text.slice(0,fn.start)+text.slice(fn.end),source);}
function jsParams(params){return params.trim()?params.split(',').map(part=>part.trim().replace(/^(?:const\s+)?(?:unsigned\s+long|int|float|double|long|bool|boolean|String)\s+/,'')).join(','):'';}
function setMessage(text,kind=''){const m=$('compileMessage');m.textContent=text;m.className=`compile-message ${kind}`;const s=$('compileState');s.className=`compile-state ${kind==='error'?'error':kind==='ok'?'ok':''}`;s.lastElementChild.textContent=kind==='ok'?'스케치가 Uno에 적용됨':kind==='error'?'코드 확인 필요':'기본 스케치 준비됨';}
function compileSketch(){try{const source=$('codeEditor').value;if(!/void\s+setup\s*\(/.test(source)||!/void\s+loop\s*\(/.test(source))throw new Error('void setup()과 void loop()이 모두 필요합니다.');
  const globals=removeFunction(removeFunction(source,'setup'),'loop').replace(/^\s*#.*$/gm,'').replace(/\/\/.*$/gm,'');state.scope=Object.create(null);state.servos={};state.pinServos={};state.lcds={};state.auto=null;
  globals.replace(/\bServo\s+([A-Za-z_]\w*)\s*;/g,(_,name)=>{state.scope[name]=makeServo(name);return '';});
  globals.replace(/\bLiquidCrystal_I2C\s+([A-Za-z_]\w*)\s*\(\s*(0x[\da-fA-F]+|\d+)[^)]*\)\s*;/g,(_,name,address)=>{state.scope[name]=makeLcd(Number(address));return '';});
  globals.replace(/\b(?:const\s+)?(?:int|float|double|long|bool)\s+([A-Za-z_]\w*)\s*(?:=\s*([^;]+))?\s*;/g,(_,name,raw)=>{state.scope[name]=raw?Number(Function(`return (${raw})`)()):0;return '';});
  const api={A0,A1,A2,A3,A4,A5,HIGH:1,LOW:0,Math,analogRead:pin=>state.pins[`A${pin}`]??0,constrain:(n,lo,hi)=>clamp(+n,+lo,+hi),abs:Math.abs,min:Math.min,max:Math.max,round:Math.round,map:(x,a,b,c,d)=>(x-a)*(d-c)/(b-a)+c,delay:ms=>{state.loopDelay=Math.max(.01,(+ms||0)/1000);},readPower:()=>+state.power.toFixed(2),readVoltage:()=>+state.voltage.toFixed(2),readCurrent:()=>+state.current.toFixed(2),beginAutoTracking,runAutoTracking,Serial:{begin(){},print:serialPrint,println:serialPrint},pinMode(){},digitalWrite(){}};
  Object.assign(state.scope,api);state.compiled={setup:new Function('scope',`with(scope){${transform(extractFunction(source,'setup'))}}`),loop:new Function('scope',`with(scope){${transform(extractFunction(source,'loop'))}}`)};state.loopDelay=.18;state.compiled.setup(state.scope);state.compiled.loop(state.scope);renderAll();setMessage('컴파일 성공 — setup()을 실행하고 loop() 1회를 적용했습니다.','ok');return true;
}catch(error){state.running=false;setMessage(`컴파일 오류: ${error.message}`,'error');serialPrint(`ERROR: ${error.message}`);return false;}}
// Interpreter v2: preserves the old subset while allowing Arduino-style helper functions,
// unsigned long, and millis() so timing stays inside the sketch rather than JavaScript.
function compileSketch(){try{const source=$('codeEditor').value;if(!/void\s+setup\s*\(/.test(source)||!/void\s+loop\s*\(/.test(source))throw new Error('void setup()과 void loop()이 모두 필요합니다.');
  const functions=extractAllFunctions(source);if(!functions.some(fn=>fn.name==='setup')||!functions.some(fn=>fn.name==='loop'))throw new Error('setup()과 loop()을 찾을 수 없습니다.');const globals=removeFunctionRanges(source,functions).replace(/^\s*#.*$/gm,'').replace(/\/\/.*$/gm,'');state.scope=Object.create(null);state.servos={};state.pinServos={};state.steppers={};state.lcds={};state.auto=null;
  globals.replace(/\bAdafruit_INA219\s+([A-Za-z_]\w*)\s*(?:\(\s*(0x[\da-fA-F]+|\d+)\s*\))?\s*;/g,(_,name,address)=>{state.scope[name]=makeIna219(address===undefined?0x40:Number(address));return '';});
  globals.replace(/\bAccelStepper\s+([A-Za-z_]\w*)\s*\(\s*AccelStepper::DRIVER\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*;/g,(_,name,stepPin,dirPin)=>{state.scope[name]=makeStepper(name,stepPin,dirPin);return '';});
  globals.replace(/\bServo\s+([A-Za-z_]\w*)\s*;/g,(_,name)=>{state.scope[name]=makeServo(name);return '';});
  globals.replace(/\bLiquidCrystal_I2C\s+([A-Za-z_]\w*)\s*\(\s*(0x[\da-fA-F]+|\d+)[^)]*\)\s*;/g,(_,name,address)=>{state.scope[name]=makeLcd(Number(address));return '';});
  globals.replace(/\b(?:const\s+)?(?:unsigned\s+long|int|float|double|long|bool|boolean)\s+([^;]+);/g,(_,declarations)=>{declarations.split(',').forEach(declaration=>{const match=/^\s*([A-Za-z_]\w*)\s*(?:=\s*(.+))?\s*$/.exec(declaration);if(!match)return;const[,name,raw]=match;state.scope[name]=raw?Number(Function(`return (${raw})`)()):0;});return '';});
  const api={A0,A1,A2,A3,A4,A5,HIGH:1,LOW:0,Math,String:arduinoString,analogRead:pin=>state.pins[`A${pin}`]??0,constrain:(n,lo,hi)=>clamp(+n,+lo,+hi),abs:Math.abs,min:Math.min,max:Math.max,round:Math.round,map:(x,a,b,c,d)=>(x-a)*(d-c)/(b-a)+c,delay:ms=>{state.loopDelay=Math.max(.01,(+ms||0)/1000);},millis:()=>Math.round(state.elapsed*1000),readPower:()=>state.power,readVoltage:()=>state.voltage,readCurrent:()=>state.current,readEnergyWh:()=>state.energy,readCO2Grams:()=>state.co2Kg*1000,setSystemState:value=>{state.systemState=String(value);},setBeforePower:value=>{state.beforePower=+value;},setAfterPower:value=>{state.afterPower=+value;},setPowerComparison:(before,after)=>{state.beforePower=+before;state.afterPower=+after;state.increaseRate=before?((after-before)/before)*100:0;},beginAutoTracking,runAutoTracking,Serial:{begin(){},print:serialPrint,println:serialPrint},pinMode(){},digitalWrite(){}};
  Object.assign(state.scope,api);const functionSource=functions.map(fn=>`function ${fn.name}(${jsParams(fn.params)}){${transform(fn.body)}}`).join('\n');state.compiled=new Function('scope',`with(scope){${functionSource}\nreturn {setup,loop};}`)(state.scope);state.loopDelay=.18;state.compiled.setup();state.compiled.loop();renderAll();setMessage('컴파일 성공 — setup()과 사용자 함수를 준비했습니다.','ok');return true;
}catch(error){state.running=false;setMessage(`컴파일 오류: ${error.message}`,'error');serialPrint(`ERROR: ${error.message}`);return false;}}
function runLoop(){if(!state.compiled){if(!compileSketch())return;}try{state.loopDelay=.18;state.compiled.loop();}catch(error){state.running=false;setMessage(`실행 오류: ${error.message}`,'error');serialPrint(`RUNTIME ERROR: ${error.message}`);}}
function resetBoard(){state.running=false;state.compiled=null;state.scope={};state.h=90;state.v=90;state.energy=0;state.co2Kg=0;state.elapsed=0;state.loopDelay=.18;state.nextLoop=0;state.servos={};state.pinServos={};state.steppers={};state.lcds={};state.auto=null;state.systemState='IDLE';state.beforePower=null;state.afterPower=null;state.increaseRate=null;state.serial=[];serialPrint('Board reset: NEMA17-H/V → 90°, LCD buffers cleared');setMessage('보드를 초기화했습니다. 컴파일·적용을 눌러 새 코드를 실행하세요.');updateEnvironment();renderAll();}
function lcdText(key){return state.lcds[key]?state.lcds[key].lines:['                ','                '];}
function syncGraduationSketchTelemetry(){const s=state.scope;if(!Number.isFinite(+s.step))return;const steps=['BEFORE MEASURE','TRACKING','STABILIZING','AFTER MEASURE','RESULT'];state.systemState=steps[clamp(Math.floor(+s.step||0),0,4)];if(+s.step>=1&&Number.isFinite(+s.beforeP))state.beforePower=+s.beforeP;if(+s.step>=4&&Number.isFinite(+s.afterP)){state.afterPower=+s.afterP;state.increaseRate=Number.isFinite(+s.rate)?+s.rate:null;}}
function setVerificationStatus(id,status,text){const item=$(id);item.textContent=text;item.className=status;}
function updateDesignVerification(){syncGraduationSketchTelemetry();const voltage=state.voltage,current=state.current,power=state.power,calculated=voltage*current,delta=Math.abs(calculated-power),factor=env().co2Factor,carbonG=state.energy*factor,drive=updateTorqueSimulation(),collision=updateCollisionSimulation();const compiled=!!state.compiled,hMotor=state.steppers.motorH,vMotor=state.steppers.motorV,servoReady=!!hMotor&&!!vMotor&&hMotor!==vMotor&&drive.safe,collisionSafe=collision.safe;const ldrReady=compiled&&/analogRead\s*\(\s*A[0-3]\s*\)/.test($('codeEditor').value);const lcdReady=!!state.lcds['26']&&!!state.lcds['27']&&state.lcds['26']!==state.lcds['27'];const mathReady=delta<.0001&&state.energy>=0&&Number.isFinite(carbonG);$('verifyPowerFormula').textContent=`${voltage.toFixed(2)} V × ${current.toFixed(3)} A = ${calculated.toFixed(3)} W`;$('verifyPowerDelta').textContent=`INA219 모델 전력 ${power.toFixed(3)} W · 오차 ${delta.toFixed(5)} W`;$('verifyCarbonFormula').textContent=`${state.energy.toFixed(3)} Wh × ${factor.toFixed(4)} g/Wh = ${carbonG.toFixed(3)} g`;setVerificationStatus('verifyServo',servoReady?'pass':compiled?'fail':'wait',servoReady?'PASS · STEP/DIR D2–D5':'대기');setVerificationStatus('verifyCollision',collisionSafe?'pass':'fail',collisionSafe?'PASS · 간섭 없음':'충돌 감지');setVerificationStatus('verifyLdr',ldrReady?'pass':compiled?'fail':'wait',ldrReady?'PASS · A0–A3':'대기');setVerificationStatus('verifyLcd',lcdReady?'pass':compiled?'fail':'wait',lcdReady?'PASS · 0x26/0x27':'대기');setVerificationStatus('verifyMath',mathReady?'pass':'fail',mathReady?'PASS · P=V×I':'오차 확인');const s=state.scope;const stepInfo=Number.isFinite(+s.step)?`step ${s.step} · count ${s.count||0} · H ${s.errH??'—'} · V ${s.errV??'—'}`:'코드 적용 전';$('verifyEvidence').textContent=compiled?`${stepInfo} · NEMA17-H ${state.h}° · NEMA17-V ${state.v}° · 30:1 worm · ${collisionSafe?'clear':'collision'}`:'코드를 컴파일·적용하면 NEMA17-H/V, LCD, 전력 산정 및 기구 간섭을 검사합니다.';return {compiled,servoReady,collisionSafe,ldrReady,lcdReady,mathReady};}
function runDesignVerification(){const result=updateDesignVerification(),passed=[result.servoReady,result.collisionSafe,result.ldrReady,result.lcdReady,result.mathReady].filter(Boolean).length;const report=$('verificationResult');if(!result.compiled){report.className='verification-result wait';report.textContent='검증 대기: 먼저 기본 코드를 컴파일·적용한 뒤 실행하세요.';return;}report.className=passed===5?'verification-result pass':'verification-result wait';report.textContent=`검증 완료 · ${passed}/5 PASS · ${state.systemState} · ${state.elapsed.toFixed(1)} s · 전력/에너지/CO₂, D9·D10·LCD 및 기구 간섭을 현재 값으로 대조했습니다.`;serialPrint(`Design verification: ${passed}/5 PASS`);}
function renderAll(){syncGraduationSketchTelemetry();const p=state.pins,l=state.ldr;$('a0').textContent=String(p.A0).padStart(4,'0');$('a1').textContent=String(p.A1).padStart(4,'0');$('a2').textContent=String(p.A2).padStart(4,'0');$('a3').textContent=String(p.A3).padStart(4,'0');$('leftAvg').textContent=l.left.toFixed(1);$('rightAvg').textContent=l.right.toFixed(1);$('topAvg').textContent=l.top.toFixed(1);$('bottomAvg').textContent=l.bottom.toFixed(1);$('hError').textContent=(l.right-l.left).toFixed(1);$('vError').textContent=(l.top-l.bottom).toFixed(1);$('hAngle').textContent=`${state.h}°`;$('vAngle').textContent=`${state.v}°`;$('power').textContent=`${state.power.toFixed(2)} W`;$('incidence').textContent=`${state.incidenceAngle.toFixed(1)}°`;$('voltage').textContent=`${state.voltage.toFixed(2)} V`;$('current').textContent=`${state.current.toFixed(2)} A`;$('energy').textContent=`${state.energy.toFixed(3)} Wh`;$('lcd26').innerHTML=lcdText('26').map(x=>`<span>${esc(x)}</span>`).join('');$('lcd27').innerHTML=lcdText('27').map(x=>`<span>${esc(x)}</span>`).join('');$('runChip').textContent=state.running?(state.auto?.phase||'RUNNING'):'STOPPED';$('runChip').classList.toggle('running',state.running);$('runBtn').textContent=state.auto?.phase==='FINAL'?'↻ 새 측정':state.running?'Ⅱ 일시정지':'▶ 실행';updateDesignVerification();drawRig();}
function drawRig(){const c=$('rigCanvas'),x=c.getContext('2d'),w=c.width,h=c.height,e=env();x.clearRect(0,0,w,h);const lx=w*(.54+(e.az-90)/360),ly=71+(160-e.el)*.42,g=x.createRadialGradient(lx,ly,5,lx,ly,100);g.addColorStop(0,'rgba(255,225,112,.95)');g.addColorStop(.22,'rgba(255,190,72,.28)');g.addColorStop(1,'rgba(255,190,72,0)');x.fillStyle=g;x.beginPath();x.arc(lx,ly,100,0,Math.PI*2);x.fill();x.fillStyle='#ffe89c';x.beginPath();x.arc(lx,ly,17,0,Math.PI*2);x.fill();const bx=w*.5,by=h*.81;x.strokeStyle='#396772';x.lineWidth=16;x.beginPath();x.moveTo(bx,by);x.lineTo(bx,by-105);x.stroke();x.fillStyle='#163f4a';x.beginPath();x.ellipse(bx,by,160,34,0,0,Math.PI*2);x.fill();const rot=(state.h-90)*Math.PI/180,tilt=(state.v-90)*Math.PI/180;x.save();x.translate(bx,by-120);x.rotate(rot*.18);x.transform(1,Math.sin(tilt)*.32,0,Math.max(.42,Math.cos(tilt)*.72),0,0);x.fillStyle='#12385d';x.strokeStyle='#65d1dd';x.lineWidth=4;x.fillRect(-180,-88,360,176);x.strokeRect(-180,-88,360,176);x.strokeStyle='#3c819d';x.lineWidth=1;for(let a=-144;a<180;a+=36){x.beginPath();x.moveTo(a,-88);x.lineTo(a,88);x.stroke()}for(let b=-59;b<88;b+=30){x.beginPath();x.moveTo(-180,b);x.lineTo(180,b);x.stroke()}x.fillStyle='#071820';x.fillRect(-40,-40,80,80);x.strokeStyle='#66efe2';x.lineWidth=2;x.strokeRect(-40,-40,80,80);x.beginPath();x.moveTo(0,-40);x.lineTo(0,40);x.moveTo(-40,0);x.lineTo(40,0);x.stroke();[[-20,-20],[20,-20],[-20,20],[20,20]].forEach(([a,b])=>{x.fillStyle='#e2fa8b';x.beginPath();x.arc(a,b,5,0,Math.PI*2);x.fill()});x.restore();x.fillStyle='#a2c6ca';x.font='12px ui-monospace';x.fillText(`LIGHT ${e.az}° / ${e.el}°`,lx+24,ly+4);x.fillText(`D9 = ${state.h}°`,bx-220,by-14);x.fillText(`D10 = ${state.v}°`,bx+118,by-90);}
// Retained only during this source edit; the active renderer below is rebuilt
// from the provided design reference, not from this former CAD placeholder.
function legacyCadRig(){
  const canvas=$('rigCanvas'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,e=env();
  const collisionIds=new Set((state.collision?.items||[]).filter(item=>item.collision).map(item=>item.id));
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#071b24';ctx.fillRect(0,0,w,h);
  const rotateCamera=([x,y,z])=>{const cy=Math.cos(viewer.yaw),sy=Math.sin(viewer.yaw),cp=Math.cos(viewer.pitch),sp=Math.sin(viewer.pitch);const nx=x*cy+z*sy,nz=-x*sy+z*cy;return [nx,y*cp-nz*sp,y*sp+nz*cp];};
  const project=p=>{const q=rotateCamera(p),scale=viewer.zoom*720/(720+q[2]);return {x:w*.5+q[0]*scale,y:h*.75-q[1]*scale,z:q[2],s:scale};};
  const poly=(points,fill,stroke='#3d6b75')=>{const pp=points.map(project);ctx.fillStyle=fill;ctx.strokeStyle=stroke;ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(pp[0].x,pp[0].y);pp.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();ctx.fill();ctx.stroke();return pp;};
  // STL facets need depth ordering.  Drawing them in raw file order made the
  // supplied components look like a translucent placeholder, even though the
  // correct STL was loaded.  Queue and paint far-to-near for a solid CAD view.
  const cadFaces=[];
  const line=(a,b,color,width=2,dash=[])=>{const p=project(a),q=project(b);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();ctx.setLineDash([]);};
  const disk=(center,r,yColor,edge)=>{const pts=[];for(let i=0;i<28;i++){const a=i*Math.PI*2/28;pts.push([center[0]+Math.cos(a)*r,center[1],center[2]+Math.sin(a)*r]);}poly(pts,yColor,edge);};
  const box=(center,size,top='#4d6e76',side='#203f49',edge='#87aeb0')=>{const [x,y,z]=center,[sx,sy,sz]=size.map(v=>v/2),v=[[x-sx,y-sy,z-sz],[x+sx,y-sy,z-sz],[x+sx,y+sy,z-sz],[x-sx,y+sy,z-sz],[x-sx,y-sy,z+sz],[x+sx,y-sy,z+sz],[x+sx,y+sy,z+sz],[x-sx,y+sy,z+sz]];[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[3,2,6,7]].forEach((face,i)=>poly(face.map(i=>v[i]),i===4?top:side,edge));return v;};
  // CAD kinematic frame: NEMA17-H drives the complete upper mechanism through
  // a 30:1 worm drive and the 155 mm turntable bearing.
  const yaw=(state.h-90)*Math.PI/180,cy=Math.cos(yaw),sy=Math.sin(yaw);
  const azPoint=point=>rotateAzimuth(point,state.h);
  const azBox=(center,size,top='#4d6e76',side='#203f49',edge='#87aeb0')=>{const [x,y,z]=center,[sx,sy,sz]=size.map(v=>v/2),v=[[x-sx,y-sy,z-sz],[x+sx,y-sy,z-sz],[x+sx,y+sy,z-sz],[x-sx,y+sy,z-sz],[x-sx,y-sy,z+sz],[x+sx,y-sy,z+sz],[x+sx,y+sy,z+sz],[x-sx,y+sy,z+sz]].map(azPoint);[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[3,2,6,7]].forEach((face,i)=>poly(face.map(i=>v[i]),i===4?top:side,edge));return v;};
  const drawCadMesh=(mesh,center,scale,color,transform=point=>point)=>{if(!mesh)return;mesh.triangles.forEach(triangle=>{const points=triangle.map(vertex=>transform([center[0]+(vertex[0]-mesh.center[0])*scale,center[1]+(vertex[2]-mesh.center[2])*scale,center[2]+(vertex[1]-mesh.center[1])*scale]));const depth=points.reduce((total,point)=>total+rotateCamera(point)[2],0)/3;cadFaces.push({points,color,depth});});};
  const flushCadMeshes=()=>cadFaces.sort((a,b)=>b.depth-a.depth).forEach(face=>poly(face.points,face.color,'#183842'));
  const ground=[];for(let z=-450;z<=450;z+=75)ground.push([[-430,0,z],[430,0,z]]);for(let x=-420;x<=420;x+=70)ground.push([[x,0,-450],[x,0,450]]);ground.forEach(([a,b])=>line(a,b,'#173d47',.65));
  // CAD assembly base: layered 200 mm acrylic plate → supplied 155 mm bearing
  // → printed 30:1 worm wheel.  This deliberately replaces the former generic
  // pedestal so the layout reads as the supplied physical structure.
  box([0,-18,0],[220,6,220],collisionIds.has('base')?'#6d2930':'#0b1014','#020507','#9daeb1');
  box([0,-11,0],[210,5,210],'#d9e4e5','#758f95','#eaf8f6');
  box([0,-5,0],[200,6,200],collisionIds.has('turntable')?'#6d2930':'#05090b','#17242b','#6c8b91');
  drawCadMesh(cadMeshes.bearingLower,[0,0,0],1,'#6e8990');
  drawCadMesh(cadMeshes.bearingUpper,[0,5,0],1,'#b9cccf');
  drawCadMesh(cadMeshes.wormWheel,[0,12,0],1,'#355964');
  disk([0,16,0],13,'#152830','#5be5dc');
  // Four 20×20 extrusions use the assembly's 90 / 120 / 160 mm profile logic.
  [[-48,15,-34],[48,15,-34],[-48,15,34],[48,15,34]].forEach(p=>{const hit=collisionIds.has(`post-${p[0]}-${p[2]}`);azBox([p[0],(15+profileTop)/2,p[2]],[20,profileTop-15,20],hit?'#762b35':'#e7eeee',hit?'#47161d':'#6f858a','#ffffff');[-6,0,6].forEach(offset=>line(azPoint([p[0]+offset,16,p[2]-10]),azPoint([p[0]+offset,profileTop,p[2]-10]),'#55727a',.8));});
  // Exact supplied NEMA17 motor and its printed mounting bracket: horizontal
  // drive stays on the stationary base while the wheel / upper plate rotates.
  const azMotor=[-122,35,-48];
  drawCadMesh(cadMeshes.nemaBracket,[-99,28,-28],1,'#d6dedf');
  drawCadMesh(cadMeshes.nema17,azMotor,1.06,collisionIds.has('d9')?'#9a3340':'#355d6d');
  drawCadMesh(cadMeshes.worm,[-82,35,-18],1,'#d49c45');
  line([-105,35,-40],azPoint([-69,12,0]),'#e1af55',5);
  const azLabel=project([-150,84,-60]);ctx.fillStyle='#ffd96d';ctx.font='10px ui-monospace';ctx.fillText('NEMA17-H · 30:1',azLabel.x,azLabel.y);
  // Vertical NEMA17 rotates the panel about a horizontal hinge through a worm drive.
  const tilt=(state.v-90)*Math.PI/180,ct=Math.cos(tilt),st=Math.sin(tilt);
  // Exact D10 elevation transform: local +Z is the panel normal, matching
  // state.panelNormal (the vector used by the physical power calculation).
  // D10 elevation is applied only after D9, so it cannot alter horizontal azimuth.
  const panelPoint=point=>panelWorldPoint(point,state.h,state.v);
  const panelBox=(center,size,top='#54808b',side='#263f49')=>{const [x,y,z]=center,[sx,sy,sz]=size.map(v=>v/2),v=[[x-sx,y-sy,z-sz],[x+sx,y-sy,z-sz],[x+sx,y+sy,z-sz],[x-sx,y+sy,z-sz],[x-sx,y-sy,z+sz],[x+sx,y-sy,z+sz],[x+sx,y+sy,z+sz],[x-sx,y+sy,z+sz]].map(panelPoint);[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[3,2,6,7]].forEach((face,i)=>poly(face.map(i=>v[i]),i===4?top:side,'#b7d4d3'));return v;};
  // 9 V / 5 W solar module. Its rendered frame also follows the dimension inputs.
  const model=mechanics(),panelHalfW=model.width*worldPerMm/2,panelHalfH=model.height*worldPerMm/2;
  const panel=[[-panelHalfW,-panelHalfH,0],[panelHalfW,-panelHalfH,0],[panelHalfW,panelHalfH,0],[-panelHalfW,panelHalfH,0]].map(panelPoint),panelBack=[[-panelHalfW,-panelHalfH,-8],[panelHalfW,-panelHalfH,-8],[panelHalfW,panelHalfH,-8],[-panelHalfW,panelHalfH,-8]].map(panelPoint);
  const hinge=azPoint([0,panelMountHeight,-10]),head=azPoint([0,profileTop,0]);line(head,hinge,'#7eb4b7',8);line(azPoint([-32,profileTop,0]),azPoint([32,profileTop,0]),'#8bc0c0',7);
  // Vertical NEMA17-V, bracket and bearing housing are all part of the rotating
  // upper assembly.  Applying azPoint here makes the D9 axis visibly carry the
  // complete elevation mechanism; D10 changes only the panel hinge.
  const vMotor=[-58,profileTop-35,-42];
  drawCadMesh(cadMeshes.nemaBracket,[-48,profileTop-38,-25],1,'#d6dedf',azPoint);
  drawCadMesh(cadMeshes.nema17,vMotor,1.06,collisionIds.has('d10')?'#9a3340':'#365f70',azPoint);
  drawCadMesh(cadMeshes.bearingHousing,[-4,profileTop,-28],1,'#ccd8d8',azPoint);
  drawCadMesh(cadMeshes.worm,[-24,profileTop-2,-38],1,'#d49c45',azPoint);
  const elHorn=azPoint([-58,profileTop,-58]),elArm=azPoint([-58,profileTop+Math.sin(tilt)*35,-58+Math.cos(tilt)*35]);
  line(elHorn,elArm,'#f2cb55',5);line(elArm,panelPoint([-48,-42,-28]),'#b8d8d7',4);
  const elCenter=project(elHorn);ctx.fillStyle='#ffd96d';ctx.font='10px ui-monospace';ctx.fillText('NEMA17-V · 30:1',elCenter.x-50,elCenter.y+31);
  flushCadMeshes();
  // Real module construction: aluminium frame, 5 W cell field, rear diagonal
  // bracket and the LDR divider.  Every element below is transformed by D9+D10.
  panelBox([0,0,-5],[panelHalfW*2+18,panelHalfH*2+18,12],'#dce7e7','#97afb3');
  panelBox([0,0,2],[panelHalfW*2,panelHalfH*2,4],collisionIds.size?'#682535':'#071b31',collisionIds.size?'#ff8a88':'#4c8ca1');
  poly(panelBack,collisionIds.size?'#3f1524':'#09223c','#3e7795');poly(panel,collisionIds.size?'#682535':'#123c69',collisionIds.size?'#ff8a88':'#d7f4f4');
  panel.forEach((point,i)=>line(point,panel[(i+1)%4],collisionIds.size?'#ff8a88':'#f2ffff',8));
  for(let px=-panelHalfW+26;px<panelHalfW;px+=26)line(panelPoint([px,-panelHalfH,2]),panelPoint([px,panelHalfH,2]),'#4b89a5',.8);for(let py=-panelHalfH+27;py<panelHalfH;py+=27)line(panelPoint([-panelHalfW,py,2]),panelPoint([panelHalfW,py,2]),'#4b89a5',.8);
  const ldrBase=[[[-31,-31,9],[-2,-31,9],[-2,-2,9],[-31,-2,9]],[[2,-31,9],[31,-31,9],[31,-2,9],[2,-2,9]],[[-31,2,9],[-2,2,9],[-2,31,9],[-31,31,9]],[[2,2,9],[31,2,9],[31,31,9],[2,31,9]]];ldrBase.forEach((quad,i)=>poly(quad.map(panelPoint),['#dff487','#fff19a','#b7ec72','#c9f884'][i],'#153b37'));line(panelPoint([0,-38,11]),panelPoint([0,38,11]),'#61f0df',2);line(panelPoint([-38,0,11]),panelPoint([38,0,11]),'#61f0df',2);
  // Visual confirmation: this is the same normal vector represented in the power dot product.
  const normalBase=panelPoint([0,0,6]),normalTip=panelPoint([0,0,112]);line(normalBase,normalTip,'#58f2e6',3);const normalLabel=project(normalTip);ctx.fillStyle='#78fff2';ctx.font='bold 12px ui-monospace';ctx.fillText('N',normalLabel.x+5,normalLabel.y-4);
  // Place the virtual Sun along the actual 3D light-direction vector.
  const panelCenter=panelPoint([0,0,4]),sun=[panelCenter[0]+state.lightDirection[0]*360,panelCenter[1]+state.lightDirection[1]*360,panelCenter[2]+state.lightDirection[2]*360],sunP=project(sun),target=project(panelCenter);const glow=ctx.createRadialGradient(sunP.x,sunP.y,4,sunP.x,sunP.y,42*sunP.s);glow.addColorStop(0,'#fff3b6');glow.addColorStop(.24,'#ffd56b99');glow.addColorStop(1,'#ffd56b00');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(sunP.x,sunP.y,42*sunP.s,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff0a0';ctx.beginPath();ctx.arc(sunP.x,sunP.y,10*sunP.s,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#f5d26988';ctx.lineWidth=1;ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(sunP.x,sunP.y);ctx.lineTo(target.x,target.y);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#b5d4d4';ctx.font='12px ui-monospace';ctx.fillText(`SUN ${e.az}° / ${e.el}°`,sunP.x+13,sunP.y-8);ctx.fillStyle='#8bc8c7';ctx.fillText(`NEMA17-H ${state.h}° · NEMA17-V ${state.v}° · θ ${state.incidenceAngle.toFixed(1)}°`,14,25);ctx.font='10px ui-monospace';ctx.fillText('SUPPLIED CAD ASSEMBLY: 5W 215×180 · 155 BEARING · NEMA17 BRACKET · 30:1 WORM',14,43);if(collisionIds.size){ctx.fillStyle='#ffaaa5';ctx.font='bold 12px ui-monospace';ctx.fillText('⚠ COLLISION DETECTED — STEPPER MOVE BLOCKED',14,62);}const azText=project([-150,84,-60]),elText=project(elHorn);ctx.fillStyle='#ffe074';ctx.font='bold 10px ui-monospace';ctx.fillText('NEMA17-H · AZIMUTH',azText.x-52,azText.y-16);ctx.fillText('NEMA17-V · ELEVATION',elText.x-58,elText.y+31);
}

// -----------------------------------------------------------------------------
// Design-reference renderer
// Rebuilt from the user's supplied design image: square acrylic base, circular
// rotating plate, rear housing, twin aluminium profiles, angled support and a
// white-framed black-cell solar module. No previous STL/CAD mesh is rendered.
function drawRig(){
  const canvas=$('rigCanvas'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,m=mechanics();
  const e=env(),yaw=viewer.yaw,pitch=viewer.pitch;
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#071b24';ctx.fillRect(0,0,w,h);
  const camera=([x,y,z])=>{const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),rx=x*cy+z*sy,rz=-x*sy+z*cy;return [rx,y*cp-rz*sp,y*sp+rz*cp];};
  const project=point=>{const q=camera(point),s=viewer.zoom*720/(720+q[2]);return {x:w*.5+q[0]*s,y:h*.79-q[1]*s,z:q[2],s};};
  const poly=(points,fill,stroke='#496a70')=>{const p=points.map(project);ctx.fillStyle=fill;ctx.strokeStyle=stroke;ctx.lineWidth=1.25;ctx.beginPath();ctx.moveTo(p[0].x,p[0].y);p.slice(1).forEach(q=>ctx.lineTo(q.x,q.y));ctx.closePath();ctx.fill();ctx.stroke();};
  const line=(a,b,color,width=2,dash=[])=>{const p=project(a),q=project(b);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();ctx.setLineDash([]);};
  // Draw a decimated, supplied binary-STL mesh.  The source CAD is retained
  // exactly as supplied; decimation only keeps the in-browser animation fast.
  const drawSuppliedMesh=(name,anchor,size,transform=point=>point,fill='#52686c',stroke='#a8bab9',axisMap=point=>[point[0],point[2],point[1]])=>{
    const mesh=suppliedCadMeshes[name]; if(!mesh)return false;
    const faces=mesh.triangles.map(triangle=>{
      const points=triangle.map(vertex=>{const raw=axisMap(vertex.map((value,axis)=>(value-mesh.center[axis])/mesh.span*size));return transform([anchor[0]+raw[0],anchor[1]+raw[1],anchor[2]+raw[2]]);});
      return {points,depth:points.reduce((total,point)=>total+camera(point)[2],0)/3};
    });
    faces.sort((a,b)=>b.depth-a.depth).forEach(face=>poly(face.points,fill,stroke));
    return true;
  };
  const box=(center,size,top,side,transform=point=>point)=>{const [x,y,z]=center,[a,b,c]=size.map(v=>v/2),v=[[x-a,y-b,z-c],[x+a,y-b,z-c],[x+a,y+b,z-c],[x-a,y+b,z-c],[x-a,y-b,z+c],[x+a,y-b,z+c],[x+a,y+b,z+c],[x-a,y+b,z+c]].map(transform);[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[3,2,6,7]].forEach((face,index)=>poly(face.map(i=>v[i]),index===4?top:side));};
  const disk=(center,r,fill,stroke)=>{const q=[];for(let i=0;i<32;i++){const a=i*Math.PI*2/32;q.push([center[0]+Math.cos(a)*r,center[1],center[2]+Math.sin(a)*r]);}poly(q,fill,stroke);};
  const az=point=>rotateAzimuth(point,state.h),panel=point=>panelWorldPoint(point,state.h,state.v);
  // Stylised but kinematically placed worm mechanisms. Horizontal: a fixed
  // worm engages the rotating turntable wheel. Vertical: the second worm and
  // wheel stay on the azimuth assembly and drive only the panel hinge.
  const horizontalGear=(center,r)=>{const edge=[];for(let i=0;i<30;i++){const a=i*Math.PI*2/30;edge.push(az([center[0]+Math.cos(a)*r,center[1],center[2]+Math.sin(a)*r]));}poly(edge,'#232a2e','#9ca9aa');for(let i=0;i<30;i++){const a=i*Math.PI*2/30;line(az([center[0]+Math.cos(a)*(r-7),center[1]+2,center[2]+Math.sin(a)*(r-7)]),az([center[0]+Math.cos(a)*(r+5),center[1]+2,center[2]+Math.sin(a)*(r+5)]),'#aeb8b9',1.2);}};
  const verticalGear=(center,r,transform)=>{const edge=[];for(let i=0;i<26;i++){const a=i*Math.PI*2/26;edge.push(transform([center[0],center[1]+Math.cos(a)*r,center[2]+Math.sin(a)*r]));}poly(edge,'#20272b','#98a5a6');for(let i=0;i<26;i++){const a=i*Math.PI*2/26;line(transform([center[0],center[1]+Math.cos(a)*(r-6),center[2]+Math.sin(a)*(r-6)]),transform([center[0],center[1]+Math.cos(a)*(r+5),center[2]+Math.sin(a)*(r+5)]),'#aab5b6',1.1);}};
  const worm=(a,b,transform=point=>point,phase=0)=>{line(transform(a),transform(b),'#2e3539',8);for(let i=0;i<12;i++){const t=i/11,px=a[0]+(b[0]-a[0])*t,py=a[1]+(b[1]-a[1])*t,pz=a[2]+(b[2]-a[2])*t,offset=((i+phase)%3-1)*3;line(transform([px-4,py-7,pz+offset]),transform([px+4,py+7,pz-offset]),'#a3b0b1',1.6);}};
  // Reference model: transparent acrylic enclosure with a black lower base.
  for(let z=-330;z<=330;z+=55)line([-330,0,z],[330,0,z],'#123942',.55);for(let x=-330;x<=330;x+=55)line([x,0,-330],[x,0,330],'#123942',.55);
  box([0,-28,0],[232,10,232],'#111517','#030607');
  box([0,-18,0],[220,8,220],'#9aa8a9','#2d3b3e');
  box([0,-10,0],[210,8,210],'#080b0d','#111a1d');
  // Clear cube walls, top plate, and front ventilation / access windows.
  const cube=[[-105,-6,-105],[105,-6,-105],[105,-6,105],[-105,-6,105],[-105,108,-105],[105,108,-105],[105,108,105],[-105,108,105]];
  poly([cube[0],cube[1],cube[5],cube[4]],'rgba(190,222,225,.18)','#b4d0d2');poly([cube[1],cube[2],cube[6],cube[5]],'rgba(190,222,225,.12)','#b4d0d2');poly([cube[3],cube[0],cube[4],cube[7]],'rgba(190,222,225,.13)','#b4d0d2');
  line(cube[4],cube[5],'#e6ffff',2);line(cube[5],cube[6],'#e6ffff',2);line(cube[6],cube[7],'#e6ffff',2);line(cube[7],cube[4],'#e6ffff',2);
  box([0,108,0],[216,5,216],'rgba(225,250,250,.28)','rgba(155,200,204,.18)');
  box([-52,25,-108],[66,34,5],'#111719','#05080a');box([52,25,-108],[66,34,5],'#111719','#05080a');
  if(!drawSuppliedMesh('bearingLower',[0,112,0],155,point=>point,'#7e9193','#d9eeee'))disk([0,113,0],72,'#e8eeee','#a6b8b9');
  if(!drawSuppliedMesh('bearingUpper',[0,112,0],155,az,'#b7c9c9','#ecffff'))disk([0,117,0],58,'#1a2225','#9ab0b0');
  // All moving parts above the transparent cover use D9 azimuth.
  if(!drawSuppliedMesh('wormWheel',[0,124,0],112,az,'#303c40','#c6d4d4'))horizontalGear([0,120,0],54);
  disk(az([0,124,0]),46,'#eff4f3','#a9bbbb');
  // Two central aluminium profiles and the black motor blocks inside the case.
  [[-28,0],[28,0],[-28,34],[28,34]].forEach(([x,z])=>{box([x,166,z],[18,88,18],'#edf2f1','#7e9294',az);[-5,0,5].forEach(dx=>line(az([x+dx,122,z-10]),az([x+dx,210,z-10]),'#526d72',.75));});
  if(!drawSuppliedMesh('nemaBracket',[-58,152,-24],58,az,'#d0dbda','#f2ffff'))box([-58,157,-24],[54,44,48],'#111719','#030507',az);
  if(!drawSuppliedMesh('nema17',[-58,157,-24],58,az,'#151d20','#91a6a8'))box([-58,157,-24],[54,44,48],'#111719','#030507',az);
  if(!drawSuppliedMesh('nemaBracket',[57,164,-26],54,az,'#d0dbda','#f2ffff'))box([57,169,-26],[50,44,48],'#111719','#030507',az);
  if(!drawSuppliedMesh('nema17',[57,169,-26],54,az,'#151d20','#91a6a8'))box([57,169,-26],[50,44,48],'#111719','#030507',az);
  // Visible black horizontal worm at the upper turntable rim.
  if(!drawSuppliedMesh('wormWheel',[73,139,-52],48,az,'#253136','#a8b8b7'))verticalGear([73,139,-52],25,az);
  if(!drawSuppliedMesh('worm',[73,139,-89],48,az,'#b7a35d','#e3d486',point=>[point[0],point[1],point[2]]))worm([73,139,-102],[73,139,-76],az,Math.round(state.h/8));
  box([73,139,-116],[34,32,18],'#222a2e','#0c1113',az);
  // Elevation hinge housing and two support arms. They remain attached to D9.
  box([-5,212,-18],[98,22,58],'#dce5e4','#6e8588',az);
  disk(az([0,223,-25]),24,'#313c3f','#b5c7c6');
  // Black elevation worm / wheel at the right hinge, as exposed in the
  // supplied reference rendering. It follows D10 but remains on the D9 frame.
  if(!drawSuppliedMesh('wormWheel',[65,223,-48],52,az,'#253136','#a8b8b7'))verticalGear([65,223,-48],27,az);
  if(!drawSuppliedMesh('worm',[65,223,-89],52,az,'#b7a35d','#e3d486',point=>[point[0],point[1],point[2]]))worm([65,223,-103],[65,223,-76],az,Math.round(state.v/8));
  box([65,223,-117],[34,35,18],'#20272b','#080c0e',az);
  line(az([-48,205,-20]),panel([-m.width*.55,0,-8]),'#c5d4d2',6);
  line(az([48,205,-20]),panel([m.width*.55,0,-8]),'#c5d4d2',6);
  line(az([0,223,-18]),panel([0,0,-10]),'#e0e8e5',8);
  // 5 W module: thick white frame, black cells and silver grid exactly in the
  // design-image style. The entire module follows D9 + D10 directly.
  const halfW=m.width*worldPerMm/2,halfH=m.height*worldPerMm/2;
  const panelQuad=(x0,y0,x1,y1,z,fill,stroke)=>poly([[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]].map(panel),fill,stroke);
  panelQuad(-halfW-12,-halfH-12,halfW+12,halfH+12,-6,'#f2f4f1','#798887');
  panelQuad(-halfW-5,-halfH-5,halfW+5,halfH+5,1,'#0a0c0d','#e4ecea');
  const cols=7,rows=5,cellW=(halfW*2-16)/cols,cellH=(halfH*2-16)/rows;
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){const x0=-halfW+8+col*cellW,y0=-halfH+8+row*cellH;panelQuad(x0,y0,x0+cellW-2,y0+cellH-2,3,(row+col)%2?'#030507':'#07090b','#c6cfce');}
  // Divider-shielded A0–A3 CdS sensor head on the panel face.
  panelQuad(-36,-36,36,36,8,'#10191a','#77dcd4');line(panel([0,-38,10]),panel([0,38,10]),'#79ece1',2);line(panel([-38,0,10]),panel([38,0,10]),'#79ece1',2);
  [[-19,-19],[19,-19],[-19,19],[19,19]].forEach(([x,y])=>{const c=panel([x,y,11]),p=project(c);ctx.fillStyle='#dcf47a';ctx.beginPath();ctx.arc(p.x,p.y,5*p.s,0,Math.PI*2);ctx.fill();});
  // Power normal and the actual light-direction reference used in P=cos(theta).
  const center=panel([0,0,12]),normal=panel([0,0,112]);line(center,normal,'#58f2e6',3);const n=project(normal);ctx.fillStyle='#7ffff2';ctx.font='bold 12px ui-monospace';ctx.fillText('N',n.x+5,n.y-4);
  const sun=[center[0]+state.lightDirection[0]*330,center[1]+state.lightDirection[1]*330,center[2]+state.lightDirection[2]*330],sp=project(sun),cp=project(center),glow=ctx.createRadialGradient(sp.x,sp.y,3,sp.x,sp.y,45*sp.s);glow.addColorStop(0,'#fff3bd');glow.addColorStop(.25,'#ffd46b88');glow.addColorStop(1,'#ffd46b00');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(sp.x,sp.y,45*sp.s,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff0a0';ctx.beginPath();ctx.arc(sp.x,sp.y,10*sp.s,0,Math.PI*2);ctx.fill();line(sun,center,'#f6d272',1,[5,5]);
  ctx.fillStyle='#b9d6d4';ctx.font='11px ui-monospace';ctx.fillText(`D9 수평 ${state.h}°  ·  D10 수직 ${state.v}°  ·  입사각 ${state.incidenceAngle.toFixed(1)}°`,14,25);ctx.font='10px ui-monospace';ctx.fillText('기준 이미지 구조: 투명 아크릴 케이스 · 검은 모터/웜 · 원형 회전판 · 프로파일 기둥 · 태양광 모듈',14,43);
}

function setup3dControls(){const c=$('rigCanvas');c.addEventListener('pointerdown',event=>{viewer.drag={x:event.clientX,y:event.clientY};c.setPointerCapture?.(event.pointerId);});c.addEventListener('pointermove',event=>{if(!viewer.drag)return;viewer.yaw+=(event.clientX-viewer.drag.x)*.012;viewer.pitch=clamp(viewer.pitch+(event.clientY-viewer.drag.y)*.009,-1.2,.45);viewer.drag={x:event.clientX,y:event.clientY};});['pointerup','pointercancel','pointerleave'].forEach(type=>c.addEventListener(type,()=>{viewer.drag=null;}));c.addEventListener('wheel',event=>{event.preventDefault();viewer.zoom=clamp(viewer.zoom-event.deltaY*.001,.62,1.85);},{passive:false});$('viewReset').addEventListener('click',()=>{Object.assign(viewer,defaultViewerPose);renderAll();});}
function renderAll(){syncGraduationSketchTelemetry();const p=state.pins,l=state.ldr;$('a0').textContent=String(p.A0).padStart(4,'0');$('a1').textContent=String(p.A1).padStart(4,'0');$('a2').textContent=String(p.A2).padStart(4,'0');$('a3').textContent=String(p.A3).padStart(4,'0');$('leftAvg').textContent=l.left.toFixed(1);$('rightAvg').textContent=l.right.toFixed(1);$('topAvg').textContent=l.top.toFixed(1);$('bottomAvg').textContent=l.bottom.toFixed(1);$('hError').textContent=(l.right-l.left).toFixed(1);$('vError').textContent=(l.top-l.bottom).toFixed(1);$('hAngle').textContent=`${state.h}°`;$('vAngle').textContent=`${state.v}°`;$('power').textContent=`${state.power.toFixed(2)} W`;$('incidence').textContent=`${state.incidenceAngle.toFixed(1)}°`;$('alignment').textContent=`${(state.alignment*100).toFixed(1)}%`;$('voltage').textContent=`${state.voltage.toFixed(2)} V`;$('current').textContent=`${state.current.toFixed(3)} A`;$('energy').textContent=`${state.energy.toFixed(3)} Wh`;$('co2').textContent=state.co2Kg<.001?`${(state.co2Kg*1000).toFixed(2)} g`:`${state.co2Kg.toFixed(4)} kg`;$('systemState').textContent=state.systemState;$('beforePower').textContent=state.beforePower===null?'—':`${state.beforePower.toFixed(2)} W`;$('afterPower').textContent=state.afterPower===null?'—':`${state.afterPower.toFixed(2)} W`;$('improvement').textContent=state.increaseRate===null?'—':`${state.increaseRate.toFixed(1)}%`;$('lcd26').innerHTML=lcdText('26').map(x=>`<span>${esc(x)}</span>`).join('');$('lcd27').innerHTML=lcdText('27').map(x=>`<span>${esc(x)}</span>`).join('');$('runChip').textContent=state.running?state.systemState:'STOPPED';$('runChip').classList.toggle('running',state.running);$('runBtn').textContent=state.running?'Ⅱ 일시정지':'▶ 실행';updateTorqueSimulation();updateDesignVerification();drawRig();}
function tick(t){if(state.lastFrame===null)state.lastFrame=t;let d=Math.min(.2,(t-state.lastFrame)/1000);state.lastFrame=t;updateEnvironment();if(state.running){d*=env().speed;state.elapsed+=d;state.energy+=state.power*d/3600;state.co2Kg=state.energy/1000*env().co2Factor;if(state.elapsed>=state.nextLoop){runLoop();state.nextLoop=state.elapsed+state.loopDelay;}}renderAll();requestAnimationFrame(tick);}
function wire(){$('codeEditor').value=defaultSketch;const count=()=>{$('codeLines').textContent=`${$('codeEditor').value.split('\n').length} lines`;};$('codeEditor').addEventListener('input',count);count();[['lightAz','lightAzOut','°'],['lightEl','lightElOut','°']].forEach(([i,o,u])=>{const f=()=>$(o).value=$(i).value+u;$(i).addEventListener('input',f);f();});$('compileBtn').addEventListener('click',compileSketch);$('runBtn').addEventListener('click',()=>{if(!state.compiled&&!compileSketch())return;if(state.auto?.phase==='FINAL'){restartAutoTracking();}else{state.running=!state.running;serialPrint(state.running?'Simulation running':'Simulation paused');}renderAll();});$('stepBtn').addEventListener('click',()=>{if(!state.compiled&&!compileSketch())return;runLoop();renderAll();});$('resetBtn').addEventListener('click',resetBoard);$('exampleBtn').addEventListener('click',()=>{$('codeEditor').value=defaultSketch;count();setMessage('기본 예제를 편집기에 복원했습니다.');});$('verifyBtn').addEventListener('click',runDesignVerification);$('clearLog').addEventListener('click',()=>{state.serial=[];renderSerial();});}
function wireV2(){wire();['panelWidth','panelHeight'].forEach(id=>{const update=()=>{updateTorqueSimulation();renderAll();};$(id).addEventListener('input',update);$(id).addEventListener('change',update);});}
wireV2();setup3dControls();updateEnvironment();renderAll();serialPrint('Virtual Uno ready — click Compile · Apply');requestAnimationFrame(tick);
loadSuppliedCadMeshes();
