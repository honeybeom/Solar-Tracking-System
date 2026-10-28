/* Uno Solar Lab — educational Arduino Uno subset interpreter.
   A0/A1/A2/A3: TL/TR/BL/BR LDR; D9: azimuth servo; D10: elevation servo.
   A4(SDA)/A5(SCL): I2C, LCD 0x26/0x27 and optional INA219 model. */
const $ = id => document.getElementById(id);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const A0 = 0, A1 = 1, A2 = 2, A3 = 3, A4 = 4, A5 = 5;

const defaultSketch = `// 2축 태양광 추적 및 탄소 저감량 모니터링 시스템
// 아두이노 우노 1개 / MG90S 서보모터 2개
// CdS 광센서 4개 / LCD 2개 / INA219 전압·전류 센서

#include <Wire.h>
#include <Servo.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_INA219.h>

// LCD1 : 추적 전 발전량, LCD2 : 추적 후 발전량 / 결과
LiquidCrystal_I2C lcd1(0x26, 16, 2);
LiquidCrystal_I2C lcd2(0x27, 16, 2);

// 전압·전류 센서 (I2C, 주소 0x40)
Adafruit_INA219 ina219;

Servo servoH;   // 수평축 (D9)
Servo servoV;   // 수직축 (D10)

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
  servoH.attach(9);
  servoV.attach(10);
  servoH.write(angleH);
  servoV.write(angleV);

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

  // MG90S 안전 범위 20~160도
  angleH = constrain(angleH, 20, 160);
  angleV = constrain(angleV, 20, 160);

  servoH.write(angleH);
  servoV.write(angleV);

  if (abs(errH) <= RANGE && abs(errV) <= RANGE) return true;
  return false;
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
  energy:0, co2Kg:0, elapsed:0, lastFrame:null, servos:{}, pinServos:{}, lcds:{}, auto:null, serial:[],
  panelNormal:[0,0,1], lightDirection:[0,0,1], incidenceAngle:0, alignment:0,
  systemState:'IDLE', beforePower:null, afterPower:null, increaseRate:null };
// Orbit-camera state for the mouse/touch controlled 3D model.
const viewer = { yaw:.62, pitch:-.33, zoom:1.04, drag:null };

function env() { const lightAzimuth=+$('lightAz').value,lightElevation=+$('lightEl').value;return { lightAzimuth,lightElevation,az:lightAzimuth,el:lightElevation,intensity:+$('intensity').value,speed:+$('speed').value,maxPower:+$('maxPower').value,co2Factor:+$('co2Factor').value }; }
function updateEnvironment() {
  const e=env(), hOff=clamp((e.lightAzimuth-state.h)/48,-1,1), vOff=clamp((e.lightElevation-state.v)/48,-1,1);
  const vectorForAngles=(azimuth,elevation)=>{const az=(azimuth-90)*Math.PI/180,el=(elevation-90)*Math.PI/180,ce=Math.cos(el);return [Math.sin(az)*ce,Math.sin(el),Math.cos(az)*ce];};
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
// Shared MG90S kinematics.  Every part of the rendered panel uses these exact
// D9/D10 angles; there is no canvas-only animation state.
function rotateAzimuth(point,azimuth=state.h){const yaw=(azimuth-90)*Math.PI/180,cy=Math.cos(yaw),sy=Math.sin(yaw),[x,y,z]=point;return [x*cy+z*sy,y,-x*sy+z*cy];}
function panelWorldPoint(point,azimuth=state.h,elevation=state.v){const tilt=(elevation-90)*Math.PI/180,ct=Math.cos(tilt),st=Math.sin(tilt),[x,y,z]=point;return rotateAzimuth([x,y*ct+z*st+143,-y*st+z*ct],azimuth);}
function esc(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function serialPrint(message){state.serial.push({time:state.elapsed,text:String(message)});if(state.serial.length>300)state.serial.shift();renderSerial();}
function renderSerial(){$('serialLog').innerHTML=state.serial.map(l=>`<div><time>${l.time.toFixed(2).padStart(6,'0')}s</time>${esc(l.text)}</div>`).join('');$('serialLog').scrollTop=$('serialLog').scrollHeight;}
function makeServo(name){return {name,pin:null,angle:90,attach(pin){this.pin=+pin;state.servos[name]=this;state.pinServos[this.pin]=this;serialPrint(`${name}.attach(D${pin})`);},write(angle){this.angle=clamp(Math.round(+angle||0),20,160);if(this.pin===9)state.h=this.angle;if(this.pin===10)state.v=this.angle;},read(){return this.angle;}};}
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
  const functions=extractAllFunctions(source);if(!functions.some(fn=>fn.name==='setup')||!functions.some(fn=>fn.name==='loop'))throw new Error('setup()과 loop()을 찾을 수 없습니다.');const globals=removeFunctionRanges(source,functions).replace(/^\s*#.*$/gm,'').replace(/\/\/.*$/gm,'');state.scope=Object.create(null);state.servos={};state.pinServos={};state.lcds={};state.auto=null;
  globals.replace(/\bAdafruit_INA219\s+([A-Za-z_]\w*)\s*(?:\(\s*(0x[\da-fA-F]+|\d+)\s*\))?\s*;/g,(_,name,address)=>{state.scope[name]=makeIna219(address===undefined?0x40:Number(address));return '';});
  globals.replace(/\bServo\s+([A-Za-z_]\w*)\s*;/g,(_,name)=>{state.scope[name]=makeServo(name);return '';});
  globals.replace(/\bLiquidCrystal_I2C\s+([A-Za-z_]\w*)\s*\(\s*(0x[\da-fA-F]+|\d+)[^)]*\)\s*;/g,(_,name,address)=>{state.scope[name]=makeLcd(Number(address));return '';});
  globals.replace(/\b(?:const\s+)?(?:unsigned\s+long|int|float|double|long|bool|boolean)\s+([^;]+);/g,(_,declarations)=>{declarations.split(',').forEach(declaration=>{const match=/^\s*([A-Za-z_]\w*)\s*(?:=\s*(.+))?\s*$/.exec(declaration);if(!match)return;const[,name,raw]=match;state.scope[name]=raw?Number(Function(`return (${raw})`)()):0;});return '';});
  const api={A0,A1,A2,A3,A4,A5,HIGH:1,LOW:0,Math,String:arduinoString,analogRead:pin=>state.pins[`A${pin}`]??0,constrain:(n,lo,hi)=>clamp(+n,+lo,+hi),abs:Math.abs,min:Math.min,max:Math.max,round:Math.round,map:(x,a,b,c,d)=>(x-a)*(d-c)/(b-a)+c,delay:ms=>{state.loopDelay=Math.max(.01,(+ms||0)/1000);},millis:()=>Math.round(state.elapsed*1000),readPower:()=>state.power,readVoltage:()=>state.voltage,readCurrent:()=>state.current,readEnergyWh:()=>state.energy,readCO2Grams:()=>state.co2Kg*1000,setSystemState:value=>{state.systemState=String(value);},setBeforePower:value=>{state.beforePower=+value;},setAfterPower:value=>{state.afterPower=+value;},setPowerComparison:(before,after)=>{state.beforePower=+before;state.afterPower=+after;state.increaseRate=before?((after-before)/before)*100:0;},beginAutoTracking,runAutoTracking,Serial:{begin(){},print:serialPrint,println:serialPrint},pinMode(){},digitalWrite(){}};
  Object.assign(state.scope,api);const functionSource=functions.map(fn=>`function ${fn.name}(${jsParams(fn.params)}){${transform(fn.body)}}`).join('\n');state.compiled=new Function('scope',`with(scope){${functionSource}\nreturn {setup,loop};}`)(state.scope);state.loopDelay=.18;state.compiled.setup();state.compiled.loop();renderAll();setMessage('컴파일 성공 — setup()과 사용자 함수를 준비했습니다.','ok');return true;
}catch(error){state.running=false;setMessage(`컴파일 오류: ${error.message}`,'error');serialPrint(`ERROR: ${error.message}`);return false;}}
function runLoop(){if(!state.compiled){if(!compileSketch())return;}try{state.loopDelay=.18;state.compiled.loop();}catch(error){state.running=false;setMessage(`실행 오류: ${error.message}`,'error');serialPrint(`RUNTIME ERROR: ${error.message}`);}}
function resetBoard(){state.running=false;state.compiled=null;state.scope={};state.h=90;state.v=90;state.energy=0;state.co2Kg=0;state.elapsed=0;state.loopDelay=.18;state.nextLoop=0;state.servos={};state.pinServos={};state.lcds={};state.auto=null;state.systemState='IDLE';state.beforePower=null;state.afterPower=null;state.increaseRate=null;state.serial=[];serialPrint('Board reset: D9/D10 → 90°, LCD buffers cleared');setMessage('보드를 초기화했습니다. 컴파일·적용을 눌러 새 코드를 실행하세요.');updateEnvironment();renderAll();}
function lcdText(key){return state.lcds[key]?state.lcds[key].lines:['                ','                '];}
function syncGraduationSketchTelemetry(){const s=state.scope;if(!Number.isFinite(+s.step))return;const steps=['BEFORE MEASURE','TRACKING','STABILIZING','AFTER MEASURE','RESULT'];state.systemState=steps[clamp(Math.floor(+s.step||0),0,4)];if(+s.step>=1&&Number.isFinite(+s.beforeP))state.beforePower=+s.beforeP;if(+s.step>=4&&Number.isFinite(+s.afterP)){state.afterPower=+s.afterP;state.increaseRate=Number.isFinite(+s.rate)?+s.rate:null;}}
function setVerificationStatus(id,status,text){const item=$(id);item.textContent=text;item.className=status;}
function updateDesignVerification(){syncGraduationSketchTelemetry();const voltage=state.voltage,current=state.current,power=state.power,calculated=voltage*current,delta=Math.abs(calculated-power),factor=env().co2Factor,carbonG=state.energy*factor;const compiled=!!state.compiled,d9=state.pinServos[9],d10=state.pinServos[10],servoReady=!!d9&&!!d10&&d9!==d10&&d9.angle>=20&&d9.angle<=160&&d10.angle>=20&&d10.angle<=160;const ldrReady=compiled&&/analogRead\s*\(\s*A[0-3]\s*\)/.test($('codeEditor').value);const lcdReady=!!state.lcds['26']&&!!state.lcds['27']&&state.lcds['26']!==state.lcds['27'];const mathReady=delta<.0001&&state.energy>=0&&Number.isFinite(carbonG);$('verifyPowerFormula').textContent=`${voltage.toFixed(2)} V × ${current.toFixed(3)} A = ${calculated.toFixed(3)} W`;$('verifyPowerDelta').textContent=`INA219 모델 전력 ${power.toFixed(3)} W · 오차 ${delta.toFixed(5)} W`;$('verifyCarbonFormula').textContent=`${state.energy.toFixed(3)} Wh × ${factor.toFixed(4)} g/Wh = ${carbonG.toFixed(3)} g`;setVerificationStatus('verifyServo',servoReady?'pass':compiled?'fail':'wait',servoReady?'PASS · D9/D10':'대기');setVerificationStatus('verifyLdr',ldrReady?'pass':compiled?'fail':'wait',ldrReady?'PASS · A0–A3':'대기');setVerificationStatus('verifyLcd',lcdReady?'pass':compiled?'fail':'wait',lcdReady?'PASS · 0x26/0x27':'대기');setVerificationStatus('verifyMath',mathReady?'pass':'fail',mathReady?'PASS · P=V×I':'오차 확인');const s=state.scope;const stepInfo=Number.isFinite(+s.step)?`step ${s.step} · count ${s.count||0} · H ${s.errH??'—'} · V ${s.errV??'—'}`:'코드 적용 전';$('verifyEvidence').textContent=compiled?`${stepInfo} · D9 ${state.h}° · D10 ${state.v}°`:'코드를 컴파일·적용하면 D9/D10, LCD, 전력 산정 연결을 검사합니다.';return {compiled,servoReady,ldrReady,lcdReady,mathReady};}
function runDesignVerification(){const result=updateDesignVerification(),passed=[result.servoReady,result.ldrReady,result.lcdReady,result.mathReady].filter(Boolean).length;const report=$('verificationResult');if(!result.compiled){report.className='verification-result wait';report.textContent='검증 대기: 먼저 기본 코드를 컴파일·적용한 뒤 실행하세요.';return;}report.className=passed===4?'verification-result pass':'verification-result wait';report.textContent=`검증 완료 · ${passed}/4 PASS · ${state.systemState} · ${state.elapsed.toFixed(1)} s · 전력/에너지/CO₂ 및 D9·D10·LCD 연결을 현재 값으로 대조했습니다.`;serialPrint(`Design verification: ${passed}/4 PASS`);}
function renderAll(){syncGraduationSketchTelemetry();const p=state.pins,l=state.ldr;$('a0').textContent=String(p.A0).padStart(4,'0');$('a1').textContent=String(p.A1).padStart(4,'0');$('a2').textContent=String(p.A2).padStart(4,'0');$('a3').textContent=String(p.A3).padStart(4,'0');$('leftAvg').textContent=l.left.toFixed(1);$('rightAvg').textContent=l.right.toFixed(1);$('topAvg').textContent=l.top.toFixed(1);$('bottomAvg').textContent=l.bottom.toFixed(1);$('hError').textContent=(l.right-l.left).toFixed(1);$('vError').textContent=(l.top-l.bottom).toFixed(1);$('hAngle').textContent=`${state.h}°`;$('vAngle').textContent=`${state.v}°`;$('power').textContent=`${state.power.toFixed(2)} W`;$('incidence').textContent=`${state.incidenceAngle.toFixed(1)}°`;$('voltage').textContent=`${state.voltage.toFixed(2)} V`;$('current').textContent=`${state.current.toFixed(2)} A`;$('energy').textContent=`${state.energy.toFixed(3)} Wh`;$('lcd26').innerHTML=lcdText('26').map(x=>`<span>${esc(x)}</span>`).join('');$('lcd27').innerHTML=lcdText('27').map(x=>`<span>${esc(x)}</span>`).join('');$('runChip').textContent=state.running?(state.auto?.phase||'RUNNING'):'STOPPED';$('runChip').classList.toggle('running',state.running);$('runBtn').textContent=state.auto?.phase==='FINAL'?'↻ 새 측정':state.running?'Ⅱ 일시정지':'▶ 실행';updateDesignVerification();drawRig();}
function drawRig(){const c=$('rigCanvas'),x=c.getContext('2d'),w=c.width,h=c.height,e=env();x.clearRect(0,0,w,h);const lx=w*(.54+(e.az-90)/360),ly=71+(160-e.el)*.42,g=x.createRadialGradient(lx,ly,5,lx,ly,100);g.addColorStop(0,'rgba(255,225,112,.95)');g.addColorStop(.22,'rgba(255,190,72,.28)');g.addColorStop(1,'rgba(255,190,72,0)');x.fillStyle=g;x.beginPath();x.arc(lx,ly,100,0,Math.PI*2);x.fill();x.fillStyle='#ffe89c';x.beginPath();x.arc(lx,ly,17,0,Math.PI*2);x.fill();const bx=w*.5,by=h*.81;x.strokeStyle='#396772';x.lineWidth=16;x.beginPath();x.moveTo(bx,by);x.lineTo(bx,by-105);x.stroke();x.fillStyle='#163f4a';x.beginPath();x.ellipse(bx,by,160,34,0,0,Math.PI*2);x.fill();const rot=(state.h-90)*Math.PI/180,tilt=(state.v-90)*Math.PI/180;x.save();x.translate(bx,by-120);x.rotate(rot*.18);x.transform(1,Math.sin(tilt)*.32,0,Math.max(.42,Math.cos(tilt)*.72),0,0);x.fillStyle='#12385d';x.strokeStyle='#65d1dd';x.lineWidth=4;x.fillRect(-180,-88,360,176);x.strokeRect(-180,-88,360,176);x.strokeStyle='#3c819d';x.lineWidth=1;for(let a=-144;a<180;a+=36){x.beginPath();x.moveTo(a,-88);x.lineTo(a,88);x.stroke()}for(let b=-59;b<88;b+=30){x.beginPath();x.moveTo(-180,b);x.lineTo(180,b);x.stroke()}x.fillStyle='#071820';x.fillRect(-40,-40,80,80);x.strokeStyle='#66efe2';x.lineWidth=2;x.strokeRect(-40,-40,80,80);x.beginPath();x.moveTo(0,-40);x.lineTo(0,40);x.moveTo(-40,0);x.lineTo(40,0);x.stroke();[[-20,-20],[20,-20],[-20,20],[20,20]].forEach(([a,b])=>{x.fillStyle='#e2fa8b';x.beginPath();x.arc(a,b,5,0,Math.PI*2);x.fill()});x.restore();x.fillStyle='#a2c6ca';x.font='12px ui-monospace';x.fillText(`LIGHT ${e.az}° / ${e.el}°`,lx+24,ly+4);x.fillText(`D9 = ${state.h}°`,bx-220,by-14);x.fillText(`D10 = ${state.v}°`,bx+118,by-90);}
// Canvas 3D renderer: lightweight perspective projection, no external library required.
function drawRig(){
  const canvas=$('rigCanvas'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,e=env();
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#071b24';ctx.fillRect(0,0,w,h);
  const rotateCamera=([x,y,z])=>{const cy=Math.cos(viewer.yaw),sy=Math.sin(viewer.yaw),cp=Math.cos(viewer.pitch),sp=Math.sin(viewer.pitch);const nx=x*cy+z*sy,nz=-x*sy+z*cy;return [nx,y*cp-nz*sp,y*sp+nz*cp];};
  const project=p=>{const q=rotateCamera(p),scale=viewer.zoom*720/(720+q[2]);return {x:w*.5+q[0]*scale,y:h*.75-q[1]*scale,z:q[2],s:scale};};
  const poly=(points,fill,stroke='#3d6b75')=>{const pp=points.map(project);ctx.fillStyle=fill;ctx.strokeStyle=stroke;ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(pp[0].x,pp[0].y);pp.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();ctx.fill();ctx.stroke();return pp;};
  const line=(a,b,color,width=2,dash=[])=>{const p=project(a),q=project(b);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();ctx.setLineDash([]);};
  const disk=(center,r,yColor,edge)=>{const pts=[];for(let i=0;i<28;i++){const a=i*Math.PI*2/28;pts.push([center[0]+Math.cos(a)*r,center[1],center[2]+Math.sin(a)*r]);}poly(pts,yColor,edge);};
  const box=(center,size,top='#4d6e76',side='#203f49',edge='#87aeb0')=>{const [x,y,z]=center,[sx,sy,sz]=size.map(v=>v/2),v=[[x-sx,y-sy,z-sz],[x+sx,y-sy,z-sz],[x+sx,y+sy,z-sz],[x-sx,y+sy,z-sz],[x-sx,y-sy,z+sz],[x+sx,y-sy,z+sz],[x+sx,y+sy,z+sz],[x-sx,y+sy,z+sz]];[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[3,2,6,7]].forEach((face,i)=>poly(face.map(i=>v[i]),i===4?top:side,edge));return v;};
  // Kinematic frame: D9 rotates the complete upper mechanism around the vertical axis.
  // D9 azimuth: the entire upper frame and the panel share this one rotation.
  const yaw=(state.h-90)*Math.PI/180,cy=Math.cos(yaw),sy=Math.sin(yaw);
  const azPoint=point=>rotateAzimuth(point,state.h);
  const azBox=(center,size,top='#4d6e76',side='#203f49',edge='#87aeb0')=>{const [x,y,z]=center,[sx,sy,sz]=size.map(v=>v/2),v=[[x-sx,y-sy,z-sz],[x+sx,y-sy,z-sz],[x+sx,y+sy,z-sz],[x-sx,y+sy,z-sz],[x-sx,y-sy,z+sz],[x+sx,y-sy,z+sz],[x+sx,y+sy,z+sz],[x-sx,y+sy,z+sz]].map(azPoint);[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[3,2,6,7]].forEach((face,i)=>poly(face.map(i=>v[i]),i===4?top:side,edge));return v;};
  const ground=[];for(let z=-450;z<=450;z+=75)ground.push([[-430,0,z],[430,0,z]]);for(let x=-420;x<=420;x+=70)ground.push([[x,0,-450],[x,0,450]]);ground.forEach(([a,b])=>line(a,b,'#173d47',.65));
  // BOM-based structure: 200×200 mm acrylic base, Ø150 mm acrylic turntable,
  // 20×20 aluminium profiles and a slip ring below the rotating plate.
  box([0,-16,0],[220,12,220],'#25363c','#0b1116','#749197');box([0,-5,0],[200,7,200],'#080d11','#17242b','#66838a');
  disk([0,2,0],75,'#d8e3e5','#79969a');disk([0,8,0],70,'#b9c9cd','#607d83');disk([0,11,0],21,'#2d4e58','#8db2b5');disk([0,14,0],13,'#162a31','#53ded6');line(azPoint([-66,12,0]),azPoint([66,12,0]),'#53ded6',3);
  [[-48,15,-34],[48,15,-34],[-48,15,34],[48,15,34]].forEach(p=>{azBox([p[0],73,p[2]],[20,116,20],'#d2e0e1','#718b91','#e6f4f2');line(azPoint([p[0]-6,16,p[2]-11]),azPoint([p[0]-6,130,p[2]-11]),'#385a63',1);line(azPoint([p[0]+6,16,p[2]-11]),azPoint([p[0]+6,130,p[2]-11]),'#385a63',1);});
  // Horizontal (D9) servo is mounted beside the rotary base; horn turns with azimuth command.
  const azServo=[-89,35,-12];box(azServo,[34,28,24],'#447e98','#1b4354','#a1cad0');box([-89,50,-12],[26,6,22],'#79aec3','#386b82','#c2e5e7');
  disk([-89,54,-12],10,'#f1c54e','#563f18');const armEnd=[-89+Math.cos(yaw)*39,54,-12+Math.sin(yaw)*39];line([-89,54,-12],armEnd,'#f2cb55',5);line(armEnd,azPoint([-66,12,0]),'#f2cb55',3);const azLabel=project([-112,70,-23]);ctx.fillStyle='#ffd96d';ctx.font='10px ui-monospace';ctx.fillText('MG90S · D9',azLabel.x,azLabel.y);
  // D10 rotates the panel about a horizontal hinge attached to the rotating head.
  const tilt=(state.v-90)*Math.PI/180,ct=Math.cos(tilt),st=Math.sin(tilt);
  // Exact D10 elevation transform: local +Z is the panel normal, matching
  // state.panelNormal (the vector used by the physical power calculation).
  // D10 elevation is applied only after D9, so it cannot alter horizontal azimuth.
  const panelPoint=point=>panelWorldPoint(point,state.h,state.v);
  const panelBox=(center,size,top='#54808b',side='#263f49')=>{const [x,y,z]=center,[sx,sy,sz]=size.map(v=>v/2),v=[[x-sx,y-sy,z-sz],[x+sx,y-sy,z-sz],[x+sx,y+sy,z-sz],[x-sx,y+sy,z-sz],[x-sx,y-sy,z+sz],[x+sx,y-sy,z+sz],[x+sx,y+sy,z+sz],[x-sx,y+sy,z+sz]].map(panelPoint);[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[3,2,6,7]].forEach((face,i)=>poly(face.map(i=>v[i]),i===4?top:side,'#b7d4d3'));return v;};
  // 9 V / 5 W solar module — 215×180 mm proportion from the actual bill of materials.
  const panel=[[-129,-108,0],[129,-108,0],[129,108,0],[-129,108,0]].map(panelPoint),panelBack=[[-129,-108,-8],[129,-108,-8],[129,108,-8],[-129,108,-8]].map(panelPoint);
  const hinge=azPoint([0,143,-10]),head=azPoint([0,126,0]);line(head,hinge,'#7eb4b7',8);line(azPoint([-32,126,0]),azPoint([32,126,0]),'#8bc0c0',7);
  // Vertical (D10) servo stays on the rotating head; its horn and linkage actuate the tilted panel.
  azBox([-49,112,-40],[34,28,24],'#4e88a2','#173e50');const elHorn=azPoint([-49,126,-52]),elArm=azPoint([-49,126+Math.sin(tilt)*35,-52+Math.cos(tilt)*35]);line(elHorn,elArm,'#f2cb55',5);line(elArm,panelPoint([-48,-42,-28]),'#b8d8d7',4);const elCenter=project(elHorn);ctx.fillStyle='#ffd96d';ctx.font='10px ui-monospace';ctx.fillText('MG90S · D10',elCenter.x-43,elCenter.y+29);line(panelPoint([-18,-31,-32]),head,'#a8c5c5',6);line(panelPoint([-72,-37,-34]),azPoint([-30,123,0]),'#8caeaf',4);
  poly(panelBack,'#09223c','#3e7795');poly(panel,'#123c69','#65d2e1');panel.forEach((point,i)=>line(point,panel[(i+1)%4],'#e5eeee',7));
  for(let x=-103;x<=103;x+=26)line(panelPoint([x,-108,2]),panelPoint([x,108,2]),'#4b89a5',.8);for(let y=-81;y<=81;y+=27)line(panelPoint([-129,y,2]),panelPoint([129,y,2]),'#4b89a5',.8);
  const ldrBase=[[[-31,-31,5],[-2,-31,5],[-2,-2,5],[-31,-2,5]],[[2,-31,5],[31,-31,5],[31,-2,5],[2,-2,5]],[[-31,2,5],[-2,2,5],[-2,31,5],[-31,31,5]],[[2,2,5],[31,2,5],[31,31,5],[2,31,5]]];ldrBase.forEach((quad,i)=>poly(quad.map(panelPoint),['#dff487','#fff19a','#b7ec72','#c9f884'][i],'#153b37'));line(panelPoint([0,-38,7]),panelPoint([0,38,7]),'#61f0df',2);line(panelPoint([-38,0,7]),panelPoint([38,0,7]),'#61f0df',2);
  // Visual confirmation: this is the same normal vector represented in the power dot product.
  const normalBase=panelPoint([0,0,6]),normalTip=panelPoint([0,0,112]);line(normalBase,normalTip,'#58f2e6',3);const normalLabel=project(normalTip);ctx.fillStyle='#78fff2';ctx.font='bold 12px ui-monospace';ctx.fillText('N',normalLabel.x+5,normalLabel.y-4);
  // Place the virtual Sun along the actual 3D light-direction vector.
  const panelCenter=panelPoint([0,0,4]),sun=[panelCenter[0]+state.lightDirection[0]*360,panelCenter[1]+state.lightDirection[1]*360,panelCenter[2]+state.lightDirection[2]*360],sunP=project(sun),target=project(panelCenter);const glow=ctx.createRadialGradient(sunP.x,sunP.y,4,sunP.x,sunP.y,42*sunP.s);glow.addColorStop(0,'#fff3b6');glow.addColorStop(.24,'#ffd56b99');glow.addColorStop(1,'#ffd56b00');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(sunP.x,sunP.y,42*sunP.s,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff0a0';ctx.beginPath();ctx.arc(sunP.x,sunP.y,10*sunP.s,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#f5d26988';ctx.lineWidth=1;ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(sunP.x,sunP.y);ctx.lineTo(target.x,target.y);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#b5d4d4';ctx.font='12px ui-monospace';ctx.fillText(`SUN ${e.az}° / ${e.el}°`,sunP.x+13,sunP.y-8);ctx.fillStyle='#8bc8c7';ctx.fillText(`D9 ${state.h}° · D10 ${state.v}° · θ ${state.incidenceAngle.toFixed(1)}°`,14,25);ctx.font='10px ui-monospace';ctx.fillText('BOM: 9V 5W 215×180 PANEL · Ø150 ACRYLIC TURNTABLE · 20×20 PROFILE',14,43);const azText=project([-89,62,-12]),elText=project(elHorn);ctx.fillStyle='#ffe074';ctx.font='bold 10px ui-monospace';ctx.fillText('MG90S D9 · AZIMUTH',azText.x-52,azText.y-16);ctx.fillText('MG90S D10 · ELEVATION',elText.x-58,elText.y+31);
}
function setup3dControls(){const c=$('rigCanvas');c.addEventListener('pointerdown',event=>{viewer.drag={x:event.clientX,y:event.clientY};c.setPointerCapture?.(event.pointerId);});c.addEventListener('pointermove',event=>{if(!viewer.drag)return;viewer.yaw+=(event.clientX-viewer.drag.x)*.012;viewer.pitch=clamp(viewer.pitch+(event.clientY-viewer.drag.y)*.009,-1.2,.45);viewer.drag={x:event.clientX,y:event.clientY};});['pointerup','pointercancel','pointerleave'].forEach(type=>c.addEventListener(type,()=>{viewer.drag=null;}));c.addEventListener('wheel',event=>{event.preventDefault();viewer.zoom=clamp(viewer.zoom-event.deltaY*.001,.62,1.85);},{passive:false});$('viewReset').addEventListener('click',()=>{viewer.yaw=.62;viewer.pitch=-.33;viewer.zoom=1.04;});}
function renderAll(){syncGraduationSketchTelemetry();const p=state.pins,l=state.ldr;$('a0').textContent=String(p.A0).padStart(4,'0');$('a1').textContent=String(p.A1).padStart(4,'0');$('a2').textContent=String(p.A2).padStart(4,'0');$('a3').textContent=String(p.A3).padStart(4,'0');$('leftAvg').textContent=l.left.toFixed(1);$('rightAvg').textContent=l.right.toFixed(1);$('topAvg').textContent=l.top.toFixed(1);$('bottomAvg').textContent=l.bottom.toFixed(1);$('hError').textContent=(l.right-l.left).toFixed(1);$('vError').textContent=(l.top-l.bottom).toFixed(1);$('hAngle').textContent=`${state.h}°`;$('vAngle').textContent=`${state.v}°`;$('power').textContent=`${state.power.toFixed(2)} W`;$('incidence').textContent=`${state.incidenceAngle.toFixed(1)}°`;$('alignment').textContent=`${(state.alignment*100).toFixed(1)}%`;$('voltage').textContent=`${state.voltage.toFixed(2)} V`;$('current').textContent=`${state.current.toFixed(3)} A`;$('energy').textContent=`${state.energy.toFixed(3)} Wh`;$('co2').textContent=state.co2Kg<.001?`${(state.co2Kg*1000).toFixed(2)} g`:`${state.co2Kg.toFixed(4)} kg`;$('systemState').textContent=state.systemState;$('beforePower').textContent=state.beforePower===null?'—':`${state.beforePower.toFixed(2)} W`;$('afterPower').textContent=state.afterPower===null?'—':`${state.afterPower.toFixed(2)} W`;$('improvement').textContent=state.increaseRate===null?'—':`${state.increaseRate.toFixed(1)}%`;$('lcd26').innerHTML=lcdText('26').map(x=>`<span>${esc(x)}</span>`).join('');$('lcd27').innerHTML=lcdText('27').map(x=>`<span>${esc(x)}</span>`).join('');$('runChip').textContent=state.running?state.systemState:'STOPPED';$('runChip').classList.toggle('running',state.running);$('runBtn').textContent=state.running?'Ⅱ 일시정지':'▶ 실행';updateDesignVerification();drawRig();}
function tick(t){if(state.lastFrame===null)state.lastFrame=t;let d=Math.min(.2,(t-state.lastFrame)/1000);state.lastFrame=t;updateEnvironment();if(state.running){d*=env().speed;state.elapsed+=d;state.energy+=state.power*d/3600;state.co2Kg=state.energy/1000*env().co2Factor;if(state.elapsed>=state.nextLoop){runLoop();state.nextLoop=state.elapsed+state.loopDelay;}}renderAll();requestAnimationFrame(tick);}
function wire(){$('codeEditor').value=defaultSketch;const count=()=>{$('codeLines').textContent=`${$('codeEditor').value.split('\n').length} lines`;};$('codeEditor').addEventListener('input',count);count();[['lightAz','lightAzOut','°'],['lightEl','lightElOut','°'],['intensity','intensityOut','%']].forEach(([i,o,u])=>{const f=()=>$(o).value=$(i).value+u;$(i).addEventListener('input',f);f();});$('compileBtn').addEventListener('click',compileSketch);$('runBtn').addEventListener('click',()=>{if(!state.compiled&&!compileSketch())return;if(state.auto?.phase==='FINAL'){restartAutoTracking();}else{state.running=!state.running;serialPrint(state.running?'Simulation running':'Simulation paused');}renderAll();});$('stepBtn').addEventListener('click',()=>{if(!state.compiled&&!compileSketch())return;runLoop();renderAll();});$('resetBtn').addEventListener('click',resetBoard);$('exampleBtn').addEventListener('click',()=>{$('codeEditor').value=defaultSketch;count();setMessage('기본 예제를 편집기에 복원했습니다.');});$('verifyBtn').addEventListener('click',runDesignVerification);$('clearLog').addEventListener('click',()=>{state.serial=[];renderSerial();});}
function wireV2(){wire();[['maxPower','maxPowerOut',' W'],['co2Factor','co2FactorOut',' kg/kWh']].forEach(([input,output,unit])=>{const update=()=>$(output).value=$(input).value+unit;$(input).addEventListener('input',update);update();});}
wireV2();setup3dControls();updateEnvironment();renderAll();serialPrint('Virtual Uno ready — click Compile · Apply');requestAnimationFrame(tick);
