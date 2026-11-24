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

const archivedDefaultSketch = `// 2축 태양광 추적 및 탄소 저감량 모니터링 시스템
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

// Default Uno sketch: two independent NEMA17 + A4988/DRV8825 axes with
// 30:1 worm reducers.  This is the code presented to users in the editor.
// It avoids runToPosition()/delay(), so both motors are serviced together.
const defaultSketch = `// ============================================================
// 2-Axis Solar Tracking and Carbon Reduction Monitor
// Arduino Uno / ATmega328P
//
// H STEP D2 / DIR D3
// V STEP D4 / DIR D5
// ENABLE D8 (active LOW)
// LDR A0~A3
// LCD1 0x26 / LCD2 0x27
// INA219 0x40
//
// Optional HOME sensors: D6, D7 (not required by default)
//
// LCD: 300ms normal refresh, changed spans only
// Control: 100ms
// Motor: AccelStepper.run() in every loop
// ============================================================

#include <Wire.h>
#include <AccelStepper.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_INA219.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

// ---------------- Hardware ----------------

LiquidCrystal_I2C lcd1(0x26, 16, 2);
LiquidCrystal_I2C lcd2(0x27, 16, 2);
Adafruit_INA219 ina219(0x40);

AccelStepper motorH(AccelStepper::DRIVER, 2, 3);
AccelStepper motorV(AccelStepper::DRIVER, 4, 5);

const uint8_t ENABLE_PIN = 8;
const uint8_t HOME_H_PIN = 6;
const uint8_t HOME_V_PIN = 7;

// Existing hardware has no HOME sensors.
// Change to true ONLY if both sensors are installed.
const bool USE_HOME_SENSORS = false;

// HOME sensor electrical level when triggered.
// Configure only when using actual HOME sensors.
const uint8_t HOME_ACTIVE_LEVEL = LOW;

// ---------------- Mechanical Settings ----------------

const float MOTOR_STEPS_PER_REV = 200.0f;
const float MICROSTEPS = 8.0f;
const float WORM_RATIO_H = 30.0f;
const float WORM_RATIO_V = 30.0f;

const float STEPS_PER_DEG_H =
  MOTOR_STEPS_PER_REV * MICROSTEPS *
  WORM_RATIO_H / 360.0f;

const float STEPS_PER_DEG_V =
  MOTOR_STEPS_PER_REV * MICROSTEPS *
  WORM_RATIO_V / 360.0f;

const int MIN_ANGLE = 20;
const int MAX_ANGLE = 160;
const int HOME_ANGLE = 90;

// Only applicable when USE_HOME_SENSORS is true.
// Assumption: HOME sensor is at the MIN side.
const int SENSOR_ANGLE_H = MIN_ANGLE;
const int SENSOR_ANGLE_V = MIN_ANGLE;

// -1 = seek toward decreasing software angle.
// Must match physical DIR wiring.
const int8_t HOME_DIR_H = -1;
const int8_t HOME_DIR_V = -1;

// ---------------- Motor Settings ----------------

// Original motion settings: unchanged
const float MAX_SPEED_H = 420.0f;
const float ACCEL_H = 260.0f;
const float MAX_SPEED_V = 320.0f;
const float ACCEL_V = 200.0f;

// Optional low-speed homing
const float HOME_SPEED_H = 180.0f;
const float HOME_SPEED_V = 160.0f;
const float HOME_ACCEL_H = 120.0f;
const float HOME_ACCEL_V = 100.0f;

const unsigned long HOME_TIMEOUT_MS = 150000UL;
const unsigned long CENTER_TIMEOUT_MS = 60000UL;
const unsigned long HOME_DEBOUNCE_MS = 20UL;
const int HOME_BACKOFF_DEG = 3;
const int HOME_MAX_TRAVEL_DEG = 142;

// ---------------- Control Settings ----------------

const int LDR_TOLERANCE = 35;
const int TRACK_STEP_DEG = 1;
const int STABLE_READS_REQUIRED = 10;

const unsigned long CONTROL_MS = 100UL;
const unsigned long LCD_MS = 300UL;
const unsigned long RESULT_PAGE_MS = 3000UL;
const unsigned long TRACK_TIMEOUT_MS = 120000UL;

const int MEASURE_SAMPLES = 50;
const int STABILIZE_SAMPLES = 300;

// INA219 default 32V/2A calibration
// Range guards, not a guarantee of correct wiring.
const float MAX_VALID_V = 32.0f;
const float MAX_VALID_CURRENT_A = 3.2f;
const uint8_t MAX_INA_ERRORS = 3;

// Keep holding torque on fault.
// Set false only if the mechanism is safe unpowered.
const bool HOLD_ON_ERROR = true;

// ---------------- States ----------------

enum Phase : uint8_t {
  PH_HOMING,
  PH_BEFORE,
  PH_TRACK,
  PH_STABILIZE,
  PH_AFTER,
  PH_RESULT,
  PH_ERROR
};

enum HomeStep : uint8_t {
  HS_H_RELEASE,
  HS_H_SEEK,
  HS_V_RELEASE,
  HS_V_SEEK,
  HS_CENTER
};

enum Fault : uint8_t {
  FAULT_NONE,
  FAULT_INA_INIT,
  FAULT_INA_READ,
  FAULT_HOME_H,
  FAULT_HOME_V,
  FAULT_HOME_CENTER,
  FAULT_TRACK_TIMEOUT,
  FAULT_H_LIMIT,
  FAULT_V_LIMIT,
  FAULT_HV_LIMIT
};

enum TrackStatus : uint8_t {
  TS_ACTIVE,
  TS_ALIGNED,
  TS_H_LIMIT,
  TS_V_LIMIT,
  TS_HV_LIMIT
};

// ---------------- Measurements ----------------

struct PowerReading {
  float voltageV;
  float currentA;
  float powerW;
};

Phase phase = PH_BEFORE;
HomeStep homeStep = HS_H_SEEK;
Fault fault = FAULT_NONE;

int targetH = HOME_ANGLE;
int targetV = HOME_ANGLE;
int errH = 0;
int errV = 0;

int sampleCount = 0;
int stableCount = 0;
uint8_t page = 0;

float sumP = 0.0f;
float sumV = 0.0f;
float sumI = 0.0f;

float beforeP = 0.0f;
float afterP = 0.0f;
float afterV = 0.0f;
float afterI = 0.0f;
float rate = 0.0f;

// Accumulate integer micro-Wh.
// Display conversion remains Wh.
uint64_t energyMicroWh = 0ULL;

unsigned long lastControlMs = 0;
unsigned long lastEnergyMs = 0;
unsigned long lastLcdMs = 0;
unsigned long trackStartMs = 0;
unsigned long resultPageMs = 0;

unsigned long homeStepStartMs = 0;
unsigned long homeDebounceMs = 0;

bool energyClockReady = false;
bool homeDebouncing = false;

uint8_t inaErrorCount = 0;

// Cached display characters.
// 2 LCD x 2 rows x 16 characters.
char lcdCache[2][2][17] = {{{0}}};

// ---------------- Forward Declarations ----------------

void refreshDisplay(bool immediate);
void enterFault(Fault code);
void setHTarget(int angle);
void setVTarget(int angle);
void beginTracking();
void beginHoming();
void updateHoming();
TrackStatus updateLdrTargets();
void updateTracking();
void updateStabilization();
void measureBefore(float p);
void measureAfter(float v, float i, float p);

// ============================================================
// Math / Motor Utilities
// ============================================================

long roundedSteps(float value) {
  return (long)(value >= 0.0f ?
                value + 0.5f : value - 0.5f);
}

long hAngleSteps(float angle) {
  return roundedSteps(
    (angle - HOME_ANGLE) * STEPS_PER_DEG_H);
}

long vAngleSteps(float angle) {
  return roundedSteps(
    (angle - HOME_ANGLE) * STEPS_PER_DEG_V);
}

long hTravelSteps(float angle) {
  return roundedSteps(angle * STEPS_PER_DEG_H);
}

long vTravelSteps(float angle) {
  return roundedSteps(angle * STEPS_PER_DEG_V);
}

void setNormalSpeeds() {
  motorH.setMaxSpeed(MAX_SPEED_H);
  motorH.setAcceleration(ACCEL_H);
  motorV.setMaxSpeed(MAX_SPEED_V);
  motorV.setAcceleration(ACCEL_V);
}

void setHomeSpeeds() {
  motorH.setMaxSpeed(HOME_SPEED_H);
  motorH.setAcceleration(HOME_ACCEL_H);
  motorV.setMaxSpeed(HOME_SPEED_V);
  motorV.setAcceleration(HOME_ACCEL_V);
}

void setHTarget(int angle) {
  targetH = constrain(angle, MIN_ANGLE, MAX_ANGLE);
  motorH.moveTo(hAngleSteps(targetH));
}

void setVTarget(int angle) {
  targetV = constrain(angle, MIN_ANGLE, MAX_ANGLE);
  motorV.moveTo(vAngleSteps(targetV));
}

// Immediate step-command stop.
// This does not decelerate the physical motor.
void emergencyStop() {
  motorH.setCurrentPosition(motorH.currentPosition());
  motorV.setCurrentPosition(motorV.currentPosition());

  if (!HOLD_ON_ERROR) {
    digitalWrite(ENABLE_PIN, HIGH);
  }
}

// ============================================================
// LCD Differential Update
// ============================================================

// Writes only contiguous changed character spans.
// No lcd.clear() during normal operation.
// Maximum 16 visible characters per row.
void writeDiff(
    LiquidCrystal_I2C &lcd,
    char *oldLine,
    uint8_t row,
    const char *source) {

  char next[17];
  uint8_t i = 0;

  while (i < 16 && source[i] != '\0') {
    next[i] = source[i];
    i++;
  }

  while (i < 16) {
    next[i++] = ' ';
  }
  next[16] = '\0';

  uint8_t pos = 0;

  while (pos < 16) {
    if (oldLine[pos] == next[pos]) {
      pos++;
      continue;
    }

    uint8_t start = pos;

    // Find the end of one contiguous changed span.
    while (pos < 16 && oldLine[pos] != next[pos]) {
      pos++;
    }

    lcd.setCursor(start, row);

    for (uint8_t j = start; j < pos; j++) {
      lcd.write((uint8_t)next[j]);
      oldLine[j] = next[j];
    }
  }

  oldLine[16] = '\0';
}

void showScreen(
    const char *a0, const char *a1,
    const char *b0, const char *b1) {

  writeDiff(lcd1, lcdCache[0][0], 0, a0);
  writeDiff(lcd1, lcdCache[0][1], 1, a1);
  writeDiff(lcd2, lcdCache[1][0], 0, b0);
  writeDiff(lcd2, lcdCache[1][1], 1, b1);
}

// AVR snprintf generally has no float %f support.
void formatFloat(
    float number, uint8_t decimals,
    char *buffer) {
  dtostrf(number, 1, decimals, buffer);
}

// ============================================================
// Display Renderer
// ============================================================

void refreshDisplay(bool immediate) {
  unsigned long now = millis();

  if (!immediate &&
      (unsigned long)(now - lastLcdMs) < LCD_MS) {
    return;
  }

  lastLcdMs = now;

  char a0[17] = "";
  char a1[17] = "";
  char b0[17] = "";
  char b1[17] = "";

  char n1[18];
  char n2[18];

  if (phase == PH_HOMING) {
    strcpy(a0, "HOMING");

    if (homeStep == HS_H_RELEASE)
      strcpy(a1, "H RELEASE");
    else if (homeStep == HS_H_SEEK)
      strcpy(a1, "H SEEK");
    else if (homeStep == HS_V_RELEASE)
      strcpy(a1, "V RELEASE");
    else if (homeStep == HS_V_SEEK)
      strcpy(a1, "V SEEK");
    else
      strcpy(a1, "MOVE TO 90 DEG");

    strcpy(b0, "POSITION SETUP");
    strcpy(b1, "MOTOR ACTIVE");
  }

  else if (phase == PH_ERROR) {
    strcpy(a0, "SYSTEM ERROR");
    strcpy(a1, "MOTORS STOPPED");

    switch (fault) {
      case FAULT_INA_INIT:
        strcpy(b0, "INA219 ERROR");
        strcpy(b1, "INIT FAILED");
        break;

      case FAULT_INA_READ:
        strcpy(b0, "INA219 ERROR");
        strcpy(b1, "READ FAILED");
        break;

      case FAULT_HOME_H:
        strcpy(b0, "H HOME ERROR");
        strcpy(b1, "CHECK SENSOR");
        break;

      case FAULT_HOME_V:
        strcpy(b0, "V HOME ERROR");
        strcpy(b1, "CHECK SENSOR");
        break;

      case FAULT_HOME_CENTER:
        strcpy(b0, "HOME ERROR");
        strcpy(b1, "CENTER TIMEOUT");
        break;

      case FAULT_TRACK_TIMEOUT:
        strcpy(b0, "TRACK ERROR");
        strcpy(b1, "TIMEOUT");
        break;

      case FAULT_H_LIMIT:
        strcpy(b0, "TRACK ERROR");
        strcpy(b1, "H LIMIT");
        break;

      case FAULT_V_LIMIT:
        strcpy(b0, "TRACK ERROR");
        strcpy(b1, "V LIMIT");
        break;

      case FAULT_HV_LIMIT:
        strcpy(b0, "TRACK ERROR");
        strcpy(b1, "HV LIMIT");
        break;

      default:
        strcpy(b0, "SYSTEM ERROR");
        strcpy(b1, "UNKNOWN");
        break;
    }
  }

  else {
    strcpy(a0, "BEFORE TRACK");

    if (phase == PH_BEFORE) {
      strcpy(a1, "MEASURING...");
    } else {
      formatFloat(beforeP, 2, n1);
      snprintf(a1, sizeof(a1), "P:%sW", n1);
    }

    if (phase == PH_BEFORE) {
      strcpy(b0, "AFTER TRACK");
      strcpy(b1, "WAIT...");
    }

    else if (phase == PH_TRACK) {
      strcpy(b0, "TRACKING");
      snprintf(
        b1, sizeof(b1),
        "H:%d V:%d", errH, errV);
    }

    else if (phase == PH_STABILIZE) {
      strcpy(b0, "TRACK COMPLETE");
      strcpy(b1, "WAIT 30 SEC");
    }

    else if (phase == PH_AFTER) {
      strcpy(b0, "AFTER MEASURE");
      strcpy(b1, "MEASURING...");
    }

    else if (phase == PH_RESULT) {
      switch (page) {
        case 0:
          strcpy(b0, "AFTER POWER");
          formatFloat(afterP, 2, n1);
          formatFloat(rate, 1, n2);
          snprintf(
            b1, sizeof(b1),
            "%sW %s%%", n1, n2);
          break;

        case 1:
          strcpy(b0, "VOLT / CURRENT");
          formatFloat(afterV, 2, n1);
          formatFloat(afterI, 2, n2);
          snprintf(
            b1, sizeof(b1),
            "%sV %sA", n1, n2);
          break;

        case 2:
          strcpy(b0, "ENERGY");
          formatFloat(
            (float)energyMicroWh / 1000000.0f,
            3, n1);
          snprintf(
            b1, sizeof(b1), "%sWh", n1);
          break;

        default:
          strcpy(b0, "CO2 REDUCTION");

          // Original carbon reduction formula unchanged.
          formatFloat(
            ((float)energyMicroWh / 1000000.0f)
              * 0.4541f,
            3, n1);
          snprintf(
            b1, sizeof(b1), "%sg", n1);
          break;
      }
    }
  }

  showScreen(a0, a1, b0, b1);
}

// ============================================================
// Error Handling
// ============================================================

void enterFault(Fault code) {
  if (phase == PH_ERROR) return;

  fault = code;
  emergencyStop();
  phase = PH_ERROR;

  // Critical error display: immediate.
  refreshDisplay(true);
}

// ============================================================
// INA219
// ============================================================

bool readPower(PowerReading &r) {
  float v = ina219.getBusVoltage_V();
  bool voltageOK = ina219.success();

  float mA = ina219.getCurrent_mA();
  bool currentOK = ina219.success();

  if (!voltageOK || !currentOK) return false;

  if (!isfinite(v) || !isfinite(mA)) return false;

  float currentA = mA / 1000.0f;

  if (v < 0.0f || v > MAX_VALID_V) return false;

  if (currentA < -MAX_VALID_CURRENT_A ||
      currentA > MAX_VALID_CURRENT_A) {
    return false;
  }

  // Preserve original behavior: negative current -> zero.
  if (currentA < 0.0f) currentA = 0.0f;

  float p = v * currentA;

  if (!isfinite(p) || p < 0.0f) return false;

  r.voltageV = v;
  r.currentA = currentA;
  r.powerW = p;
  return true;
}

// Real-time energy accumulation.
// Integer microWh avoids repeated addition into a large float.
void accumulateEnergy(
    unsigned long now,
    bool valid,
    float powerW) {

  if (!energyClockReady) {
    lastEnergyMs = now;
    energyClockReady = true;
    return;
  }

  unsigned long dt = now - lastEnergyMs;
  lastEnergyMs = now;

  if (!valid || dt == 0) return;

  // microWh = W * milliseconds / 3.6
  // Avoid non-finite values and overflow.
  float increment = powerW * ((float)dt / 3.6f);

  if (!isfinite(increment) || increment <= 0.0f)
    return;

  // This project's normal increments are far below this.
  // Additional guard against anomalous intervals.
  if (increment > 1000000000.0f) return;

  uint64_t add = (uint64_t)(increment + 0.5f);
  if (UINT64_MAX - energyMicroWh < add) return;

  energyMicroWh += add;
}

// ============================================================
// Optional HOME Sensor Utilities
// ============================================================

bool homeActive(uint8_t pin) {
  return digitalRead(pin) == HOME_ACTIVE_LEVEL;
}

void resetHomeDebounce() {
  homeDebouncing = false;
}

bool homeStable(
    uint8_t pin,
    bool expected,
    unsigned long now) {

  if (homeActive(pin) != expected) {
    homeDebouncing = false;
    return false;
  }

  if (!homeDebouncing) {
    homeDebouncing = true;
    homeDebounceMs = now;
    return false;
  }

  return (unsigned long)(now - homeDebounceMs)
           >= HOME_DEBOUNCE_MS;
}

void startHSeek() {
  homeStep = HS_H_SEEK;
  homeStepStartMs = millis();
  resetHomeDebounce();

  motorH.move(
    (long)HOME_DIR_H *
    hTravelSteps(HOME_MAX_TRAVEL_DEG));

  refreshDisplay(true);
}

void startVSeek() {
  homeStep = HS_V_SEEK;
  homeStepStartMs = millis();
  resetHomeDebounce();

  motorV.move(
    (long)HOME_DIR_V *
    vTravelSteps(HOME_MAX_TRAVEL_DEG));

  refreshDisplay(true);
}

void prepareVHome() {
  if (homeActive(HOME_V_PIN)) {
    homeStep = HS_V_RELEASE;
    homeStepStartMs = millis();
    resetHomeDebounce();

    motorV.move(
      (long)(-HOME_DIR_V) *
      vTravelSteps(HOME_BACKOFF_DEG));

    refreshDisplay(true);
  } else {
    startVSeek();
  }
}

void beginHoming() {
  phase = PH_HOMING;
  setHomeSpeeds();

  if (homeActive(HOME_H_PIN)) {
    homeStep = HS_H_RELEASE;
    homeStepStartMs = millis();
    resetHomeDebounce();

    motorH.move(
      (long)(-HOME_DIR_H) *
      hTravelSteps(HOME_BACKOFF_DEG));

    refreshDisplay(true);
  } else {
    startHSeek();
  }
}

void updateHoming() {
  unsigned long now = millis();

  switch (homeStep) {
    case HS_H_RELEASE:
      if (homeStable(HOME_H_PIN, false, now)) {
        motorH.setCurrentPosition(motorH.currentPosition());
        startHSeek();
      } else if (
          (unsigned long)(now - homeStepStartMs)
             >= HOME_TIMEOUT_MS ||
          (motorH.distanceToGo() == 0 &&
           homeActive(HOME_H_PIN))) {
        enterFault(FAULT_HOME_H);
      }
      break;

    case HS_H_SEEK:
      if (homeStable(HOME_H_PIN, true, now)) {
        motorH.setCurrentPosition(
          hAngleSteps(SENSOR_ANGLE_H));

        targetH = SENSOR_ANGLE_H;
        prepareVHome();
      } else if (
          (unsigned long)(now - homeStepStartMs)
            >= HOME_TIMEOUT_MS ||
          motorH.distanceToGo() == 0) {
        enterFault(FAULT_HOME_H);
      }
      break;

    case HS_V_RELEASE:
      if (homeStable(HOME_V_PIN, false, now)) {
        motorV.setCurrentPosition(motorV.currentPosition());
        startVSeek();
      } else if (
          (unsigned long)(now - homeStepStartMs)
             >= HOME_TIMEOUT_MS ||
          (motorV.distanceToGo() == 0 &&
           homeActive(HOME_V_PIN))) {
        enterFault(FAULT_HOME_V);
      }
      break;

    case HS_V_SEEK:
      if (homeStable(HOME_V_PIN, true, now)) {
        motorV.setCurrentPosition(
          vAngleSteps(SENSOR_ANGLE_V));

        targetV = SENSOR_ANGLE_V;
        setNormalSpeeds();

        setHTarget(HOME_ANGLE);
        setVTarget(HOME_ANGLE);

        homeStep = HS_CENTER;
        homeStepStartMs = now;
        refreshDisplay(true);
      } else if (
          (unsigned long)(now - homeStepStartMs)
            >= HOME_TIMEOUT_MS ||
          motorV.distanceToGo() == 0) {
        enterFault(FAULT_HOME_V);
      }
      break;

    case HS_CENTER:
      if (motorH.distanceToGo() == 0 &&
          motorV.distanceToGo() == 0) {
        phase = PH_BEFORE;
        sampleCount = 0;
        sumP = sumV = sumI = 0.0f;
        refreshDisplay(true);
      } else if (
          (unsigned long)(now - homeStepStartMs)
            >= CENTER_TIMEOUT_MS) {
        enterFault(FAULT_HOME_CENTER);
      }
      break;
  }
}

// ============================================================
// Tracking
// ============================================================

void beginTracking() {
  phase = PH_TRACK;
  stableCount = 0;
  trackStartMs = millis();
  refreshDisplay(true);
}

// Original four-LDR error equations and directions unchanged.
TrackStatus updateLdrTargets() {
  int tl = analogRead(A0);
  int tr = analogRead(A1);
  int bl = analogRead(A2);
  int br = analogRead(A3);

  errH = (tl + bl) / 2 - (tr + br) / 2;
  errV = (tl + tr) / 2 - (bl + br) / 2;

  bool hAligned = abs(errH) <= LDR_TOLERANCE;
  bool vAligned = abs(errV) <= LDR_TOLERANCE;

  bool hBlocked = false;
  bool vBlocked = false;

  if (!hAligned && motorH.distanceToGo() == 0) {
    int nextH = targetH +
      (errH > 0 ? -TRACK_STEP_DEG : TRACK_STEP_DEG);

    if (nextH < MIN_ANGLE || nextH > MAX_ANGLE)
      hBlocked = true;
    else
      setHTarget(nextH);
  }

  if (!vAligned && motorV.distanceToGo() == 0) {
    int nextV = targetV +
      (errV > 0 ? TRACK_STEP_DEG : -TRACK_STEP_DEG);

    if (nextV < MIN_ANGLE || nextV > MAX_ANGLE)
      vBlocked = true;
    else
      setVTarget(nextV);
  }

  if (hBlocked && vBlocked) return TS_HV_LIMIT;
  if (hBlocked) return TS_H_LIMIT;
  if (vBlocked) return TS_V_LIMIT;

  if (hAligned && vAligned) return TS_ALIGNED;
  return TS_ACTIVE;
}

bool checkTrackingFault(TrackStatus status) {
  if (status == TS_H_LIMIT) {
    enterFault(FAULT_H_LIMIT);
    return true;
  }

  if (status == TS_V_LIMIT) {
    enterFault(FAULT_V_LIMIT);
    return true;
  }

  if (status == TS_HV_LIMIT) {
    enterFault(FAULT_HV_LIMIT);
    return true;
  }

  return false;
}

void updateTracking() {
  if ((unsigned long)(millis() - trackStartMs)
        >= TRACK_TIMEOUT_MS) {
    enterFault(FAULT_TRACK_TIMEOUT);
    return;
  }

  TrackStatus status = updateLdrTargets();

  if (checkTrackingFault(status)) return;

  if (status == TS_ALIGNED &&
      motorH.distanceToGo() == 0 &&
      motorV.distanceToGo() == 0) {
    stableCount++;
  } else {
    stableCount = 0;
  }

  if (stableCount >= STABLE_READS_REQUIRED) {
    phase = PH_STABILIZE;
    sampleCount = 0;
    refreshDisplay(true);
  }
}

// ============================================================
// Measurement Phases
// ============================================================

void measureBefore(float p) {
  sumP += p;
  sampleCount++;

  if (sampleCount >= MEASURE_SAMPLES) {
    beforeP = sumP / (float)sampleCount;
    sumP = 0.0f;
    sampleCount = 0;
    beginTracking();
  }
}

void updateStabilization() {
  int oldH = errH;
  int oldV = errV;

  TrackStatus status = updateLdrTargets();

  if (checkTrackingFault(status)) return;

  if (status != TS_ALIGNED ||
      abs(oldH - errH) > LDR_TOLERANCE ||
      abs(oldV - errV) > LDR_TOLERANCE) {

    sampleCount = 0;
    stableCount = 0;
    beginTracking();
    return;
  }

  sampleCount++;

  if (sampleCount >= STABILIZE_SAMPLES) {
    phase = PH_AFTER;
    sampleCount = 0;
    sumP = sumV = sumI = 0.0f;
    refreshDisplay(true);
  }
}

void measureAfter(float v, float i, float p) {
  sumP += p;
  sumV += v;
  sumI += i;
  sampleCount++;

  if (sampleCount >= MEASURE_SAMPLES) {
    afterP = sumP / (float)sampleCount;
    afterV = sumV / (float)sampleCount;
    afterI = sumI / (float)sampleCount;

    // Original increase-rate formula unchanged.
    rate = beforeP > 0.01f ?
      (afterP - beforeP) * 100.0f / beforeP :
      0.0f;

    sumP = sumV = sumI = 0.0f;
    sampleCount = 0;

    page = 0;
    phase = PH_RESULT;
    resultPageMs = millis();

    refreshDisplay(true);
  }
}

void updateResultPages(unsigned long now) {
  if ((unsigned long)(now - resultPageMs)
        >= RESULT_PAGE_MS) {
    resultPageMs = now;
    page = (page + 1) % 4;
    refreshDisplay(true);
  }
}

// ============================================================
// Setup
// ============================================================

void setup() {
  pinMode(ENABLE_PIN, OUTPUT);
  digitalWrite(ENABLE_PIN, LOW);

  // Only used in optional actual-sensor homing mode.
  if (USE_HOME_SENSORS) {
    pinMode(HOME_H_PIN, INPUT_PULLUP);
    pinMode(HOME_V_PIN, INPUT_PULLUP);
  }

  setNormalSpeeds();

  Wire.begin();

  lcd1.init();
  lcd1.backlight();
  lcd2.init();
  lcd2.backlight();

  // Sensor initialization must be checked.
  if (!ina219.begin()) {
    enterFault(FAULT_INA_INIT);
    return;
  }

  ina219.setCalibration_32V_2A();

  lastControlMs = millis();
  lastLcdMs = lastControlMs;

  if (USE_HOME_SENSORS) {
    beginHoming();
  } else {
    // Manual zero assumption.
    // The physical axes MUST already be at 90 degrees.
    // This is not actual Homing.
    motorH.setCurrentPosition(0);
    motorV.setCurrentPosition(0);
    targetH = HOME_ANGLE;
    targetV = HOME_ANGLE;

    phase = PH_BEFORE;
    refreshDisplay(true);
  }
}

// ============================================================
// Loop
// ============================================================

void loop() {
  // Optional homing switch detection comes before run().
  if (phase == PH_HOMING) {
    updateHoming();
  }

  // Highest-frequency cooperative motor service.
  // Not restricted to the 100ms control period.
  if (phase != PH_ERROR) {
    motorH.run();
    motorV.run();
  }

  if (phase == PH_ERROR) return;

  unsigned long now = millis();

  if ((unsigned long)(now - lastControlMs)
        >= CONTROL_MS) {

    lastControlMs = now;

    PowerReading r;
    r.voltageV = 0.0f;
    r.currentA = 0.0f;
    r.powerW = 0.0f;

    bool valid = readPower(r);

    accumulateEnergy(now, valid, r.powerW);

    if (!valid) {
      if (inaErrorCount < 255) inaErrorCount++;

      if (inaErrorCount >= MAX_INA_ERRORS) {
        enterFault(FAULT_INA_READ);
      }

      // Invalid values are never used for phase sampling.
      return;
    }

    inaErrorCount = 0;

    switch (phase) {
      case PH_BEFORE:
        measureBefore(r.powerW);
        break;

      case PH_TRACK:
        updateTracking();
        break;

      case PH_STABILIZE:
        updateStabilization();
        break;

      case PH_AFTER:
        measureAfter(
          r.voltageV, r.currentA, r.powerW);
        break;

      case PH_RESULT:
        updateResultPages(now);
        break;

      default:
        break;
    }
  }

  // Normal 300ms display service.
  // All phase/error transitions call refreshDisplay(true).
  refreshDisplay(false);
}`;

// Default production sketch: AM-CS2 horizontal motor and L298N vertical motor.
// V_MAX_DEG is deliberately ±45° about the mechanical centre, not ±15°.
const half4WireDefaultSketch = `/* 2-axis CDS solar tracker: production HALF4WIRE example */
#define USE_INA219 1  // simulator virtual INA219; set 0 only when hardware has no INA219
#include <Wire.h>
#include <AccelStepper.h>
#include <LiquidCrystal_I2C.h>
#include <Adafruit_INA219.h>

const bool BRIGHTER_IS_HIGH = true;
const int H_LEFT_SIGN = -1;
const int V_TOP_SIGN = +1;
const float GEAR_RATIO_1 = 1.0f;
const float GEAR_RATIO_2 = 30.0f;
const int H_MAX_DEG = 90;       // centre ±90°
const int V_MAX_DEG = 45;       // centre ±45°: 45~135° in the simulator
const int H_LIGHT_STOP = 40;
const int H_LIGHT_START = 65;
const unsigned long H_CONFIRM_MS = 250UL;
const unsigned long H_PRESTOP_MS = 100UL;
const float H_FILTER_ALPHA = 0.35f;
const int V_LIGHT_STOP = 35;
const int V_LIGHT_START = 45;
const int MIN_LIGHT = 60;
const unsigned long SENSOR_MS = 25UL;
const unsigned long LCD_MS = 350UL;
const unsigned long PAGE_MS = 2000UL;  // LCD1/LCD2 page change interval
const unsigned long SERIAL_MS = 1000UL;
const float MAX_SPEED_1 = 22.22f;      // 1:1 수평축: 패널 기준 약 20°/s
const float MAX_SPEED_2 = 133.33f;
const float ACCELERATION_1 = 44.44f;   // 수평축: 패널 기준 약 40°/s²
const float ACCELERATION_2 = 350.0f;

// AM-CS2: D2=A, D3=B, D4=/A, D5=/B. L298N: D6~D9.
AccelStepper motor1(AccelStepper::HALF4WIRE, 2, 4, 3, 5);
AccelStepper motor2(AccelStepper::HALF4WIRE, 6, 7, 8, 9);
LiquidCrystal_I2C lcd1(0x26, 16, 2);
LiquidCrystal_I2C lcd2(0x27, 16, 2);
Adafruit_INA219 ina219(0x40); // I2C: SDA=A4, SCL=A5, R100 shunt
const int CDS_PINS[4] = {A0, A1, A2, A3}; // A0 RT, A1 RB, A2 LT, A3 LB
const float HALF_STEPS_PER_REV = 400.0f;
int cds[4] = {0,0,0,0}, errorH = 0, errorV = 0, lightLevel = 0;
float filteredErrorH = 0; bool hFilterInitialized = false;
int pendingH = 0, directionH = 0, directionV = 0;
unsigned long pendingHSince = 0, lastSensor = 0, lastLCD = 0, lastPage = 0, lastSerial = 0;
unsigned long lastPowerMs = 0;
float energyWh = 0;
uint8_t lcdPage = 0;
long maxStepsH = 0, maxStepsV = 0;
char cache1[2][17] = {{0}}, cache2[2][17] = {{0}};

long degreesToSteps(int d, float gear) { return (long)(d * HALF_STEPS_PER_REV * gear / 360.0f); }
int stepsToDegrees(long s, float gear) { return (int)(s * 360.0f / (HALF_STEPS_PER_REV * gear)); }

void readCDS() {
  int b[4], sum = 0;
  for (byte i=0; i<4; i++) { cds[i] = analogRead(CDS_PINS[i]); b[i] = BRIGHTER_IS_HIGH ? cds[i] : 1023-cds[i]; sum += b[i]; }
  int left=(b[2]+b[3])/2, right=(b[0]+b[1])/2, top=(b[0]+b[2])/2, bottom=(b[1]+b[3])/2;
  int rawH = left-right;
  if (!hFilterInitialized) { filteredErrorH=rawH; hFilterInitialized=true; }
  else filteredErrorH += H_FILTER_ALPHA * (rawH-filteredErrorH);
  errorH=(int)filteredErrorH; errorV=top-bottom; lightLevel=sum/4;
}
int chooseDirection(int error, int sign, int previous, int stopValue, int startValue) {
  int magnitude=abs(error); if (lightLevel<MIN_LIGHT || magnitude<=stopValue) return 0;
  int wanted=error>0 ? sign : -sign;
  return previous!=wanted ? (magnitude>=startValue ? wanted : 0) : previous;
}
void applyDirection(AccelStepper &motor, int wanted, int &previous, long limitSteps) {
  if (wanted==previous) return;
  if (wanted>0) motor.moveTo(limitSteps); else if (wanted<0) motor.moveTo(-limitSteps); else motor.stop();
  previous=wanted;
}
void updateHorizontal(unsigned long now) {
  int wanted=chooseDirection(errorH,H_LEFT_SIGN,directionH,H_LIGHT_STOP,H_LIGHT_START);
  if (!wanted) { pendingH=0; applyDirection(motor1,0,directionH,maxStepsH); return; }
  if (wanted==directionH) { pendingH=0; return; }
  if (wanted!=pendingH) { pendingH=wanted; pendingHSince=now; return; }
  unsigned long elapsed=now-pendingHSince;
  if (elapsed>=H_PRESTOP_MS && directionH) applyDirection(motor1,0,directionH,maxStepsH);
  if (elapsed>=H_CONFIRM_MS) { applyDirection(motor1,wanted,directionH,maxStepsH); pendingH=0; }
}
void updateTracking(unsigned long now) {
  updateHorizontal(now);
  applyDirection(motor2,chooseDirection(errorV,V_TOP_SIGN,directionV,V_LIGHT_STOP,V_LIGHT_START),directionV,maxStepsV);
}
void writeRow(LiquidCrystal_I2C &lcd, char oldLine[17], byte row, const char *text) {
  char next[17]; byte i=0; while(i<16 && text[i]) next[i]=text[i++]; while(i<16) next[i++]=' '; next[16]=0;
  for(byte col=0; col<16; col++) if(oldLine[col]!=next[col]) { lcd.setCursor(col,row); lcd.write(next[col]); oldLine[col]=next[col]; }
}
void updateLCD() {
  char line[17];
  if(lcdPage==0) {
    float voltage=ina219.getBusVoltage_V();
    float current=ina219.getCurrent_mA()/1000.0f; if(current<0) current=0;
    float power=voltage*current;
    unsigned long now=millis();
    if(lastPowerMs) energyWh += power*(float)(now-lastPowerMs)/3600000.0f;
    lastPowerMs=now;
    // String(value, decimals) is supported by Arduino Uno.  It avoids AVR
    // printf's optional float-format linker setting while keeping each row
    // within the 16-character buffer managed by writeRow().
    String row1="V:"+String(voltage,2)+" I:"+String((int)(current*1000))+"mA";
    String row2="P:"+String(power,2)+"W E:"+String(energyWh,2);
    writeRow(lcd1,cache1[0],0,row1.c_str());
    writeRow(lcd1,cache1[1],1,row2.c_str());
    writeRow(lcd2,cache2[0],0,"AF:MEASURING"); writeRow(lcd2,cache2[1],1,"UP:MEASURING");
  } else {
    snprintf(line,sizeof(line),"RT:%04d RB:%04d",cds[0],cds[1]); writeRow(lcd1,cache1[0],0,line);
    snprintf(line,sizeof(line),"LT:%04d LB:%04d",cds[2],cds[3]); writeRow(lcd1,cache1[1],1,line);
    snprintf(line,sizeof(line),"H:%+04d V:%+04d",stepsToDegrees(motor1.currentPosition(),GEAR_RATIO_1),stepsToDegrees(motor2.currentPosition(),GEAR_RATIO_2)); writeRow(lcd2,cache2[0],0,line);
    if(lightLevel<MIN_LIGHT) writeRow(lcd2,cache2[1],1,"LOW LIGHT HOLD");
    else if(directionH==0 && directionV==0) writeRow(lcd2,cache2[1],1,"LIGHT BALANCED");
    else { snprintf(line,sizeof(line),"E:%+05d,%+05d",errorH,errorV); writeRow(lcd2,cache2[1],1,line); }
  }
}
void setup() {
  Serial.begin(115200); Wire.begin(); lcd1.init(); lcd1.backlight(); lcd2.init(); lcd2.backlight(); ina219.begin();
  motor1.setMaxSpeed(MAX_SPEED_1); motor1.setAcceleration(ACCELERATION_1); motor2.setMaxSpeed(MAX_SPEED_2); motor2.setAcceleration(ACCELERATION_2);
  motor1.setCurrentPosition(0); motor2.setCurrentPosition(0); maxStepsH=degreesToSteps(H_MAX_DEG,GEAR_RATIO_1); maxStepsV=degreesToSteps(V_MAX_DEG,GEAR_RATIO_2);
  readCDS(); updateTracking(millis()); updateLCD();
}
void loop() {
  motor1.run(); motor2.run(); unsigned long now=millis();
  if(now-lastSensor>=SENSOR_MS) { lastSensor=now; readCDS(); updateTracking(now); }
  if(now-lastPage>=PAGE_MS) { lastPage=now; lcdPage^=1; lastLCD=now; updateLCD(); }
  else if(now-lastLCD>=LCD_MS) { lastLCD=now; updateLCD(); }
  if(now-lastSerial>=SERIAL_MS) { lastSerial=now; Serial.print("ERR H,V:"); Serial.print(errorH); Serial.print(','); Serial.println(errorV); }
  motor1.run(); motor2.run();
}`;

const state = { running:false, compiled:null, scope:{}, loopDelay:.18, nextLoop:0, h:90, v:90,
  pins:{A0:0,A1:0,A2:0,A3:0}, ldr:{left:0,right:0,top:0,bottom:0}, power:0, voltage:0, current:0,
  energy:0, co2Kg:0, elapsed:0, lastFrame:null, servos:{}, pinServos:{}, steppers:{}, lcds:{}, auto:null, serial:[],
  panelNormal:[0,0,1], lightDirection:[0,0,1], incidenceAngle:0, alignment:0,
  systemState:'IDLE', beforePower:null, afterPower:null, increaseRate:null, pagedLcd:null, inaTelemetry:null, collision:{safe:true,items:[],minimum:0} };
// Orbit-camera state for the mouse/touch controlled 3D model.
// Reference-camera pose: a centred front-right isometric view that keeps the
// panel, elevation hinge, rotating base, and acrylic enclosure in one frame.
// Both the initial render and “시점 초기화” use this one source of truth.
const defaultViewerPose = Object.freeze({ yaw: .18, pitch: -.68, zoom: 1.10 });
const viewer = { ...defaultViewerPose, drag:null };
function env() { const lightAzimuth=+$('lightAz').value,lightElevation=+$('lightEl').value;return { lightAzimuth,lightElevation,az:lightAzimuth,el:lightElevation,intensity:85,speed:+$('speed').value,maxPower:5,co2Factor:.4541 }; }
function mechanics(){const value=(id,fallback)=>{const raw=$(id)?.value;const n=raw===''||raw===undefined?fallback:+raw;return Number.isFinite(n)?Math.max(0,n):fallback;};return {width:value('panelWidth',215),height:value('panelHeight',180),bearingSide:155,bearingHeight:10,nema:[42,59.2,42],gearRatio:30,halfStepsPerRev:400};}
// Conservative, adjustable-in-code engineering assumptions. They are a design
// estimate, not a replacement for measuring motor torque and bearing drag.
const driveAssumptions=Object.freeze({rotatingMassKg:1.5,bearingRollingMu:.015,directDriveEfficiency:.85,wormEfficiency:.55,usableNemaTorqueNm:.099});
function mechanicalAxisDynamics(axis,gear,requestedAcceleration,source=$('codeEditor')?.value||''){
  const m=mechanics(),a=driveAssumptions,stepsPerDegree=m.halfStepsPerRev*gear/360;
  const speedSteps=axis==='H'?sourceNumber(source,'MAX_SPEED_1',22.22):sourceNumber(source,'MAX_SPEED_2',133.33);
  const accelerationSteps=Number.isFinite(requestedAcceleration)?requestedAcceleration:(axis==='H'?sourceNumber(source,'ACCELERATION_1',44.44):sourceNumber(source,'ACCELERATION_2',350));
  const width=m.width/1000,height=m.height/1000,radius=m.bearingSide/2000;
  const inertia=a.rotatingMassKg*(width*width+height*height)/12;
  const frictionNm=axis==='H'?a.rotatingMassKg*9.80665*a.bearingRollingMu*radius:.006;
  const transmission=axis==='H'?a.directDriveEfficiency:gear*a.wormEfficiency;
  const availableNm=a.usableNemaTorqueNm*transmission;
  const accelerationRad=accelerationSteps/stepsPerDegree*Math.PI/180;
  const demandNm=frictionNm+inertia*accelerationRad;
  const maxAccelerationSteps=Math.max(0,(availableNm-frictionNm)/Math.max(inertia,.000001)*180/Math.PI*stepsPerDegree);
  const effectiveAcceleration=Math.min(accelerationSteps,maxAccelerationSteps);
  return {stepsPerDegree,speedSteps,accelerationSteps,speedDeg:speedSteps/stepsPerDegree,accelerationDeg:accelerationSteps/stepsPerDegree,frictionNm,inertia,availableNm,demandNm,utilization:demandNm/Math.max(availableNm,.000001),effectiveAcceleration};
}
function updateTorqueSimulation(){
  const m=mechanics(),source=$('codeEditor')?.value||'',h=mechanicalAxisDynamics('H',1,undefined,source),v=mechanicalAxisDynamics('V',m.gearRatio,undefined,source);
  $('d9Torque').textContent=`${h.stepsPerDegree.toFixed(2)} step/° · ${h.speedDeg.toFixed(1)}°/s`;
  $('d10Torque').textContent=`${v.stepsPerDegree.toFixed(2)} step/° · ${v.speedDeg.toFixed(1)}°/s`;
  $('safeTorque').textContent=`${h.demandNm.toFixed(3)} N·m · ${(h.utilization*100).toFixed(0)}%`;
  const status=h.utilization<.6?'safe':h.utilization<1?'caution':'risk',label=status==='safe'?'수평축 여유 양호':status==='caution'?'수평축 주의':'수평축 탈조 위험';
  $('torqueVerdict').textContent=label;$('torqueVerdict').className=`torque-verdict ${status}`;
  $('torqueAdvice').textContent=`가정: 회전 하중 ${driveAssumptions.rotatingMassKg.toFixed(1)} kg · 회전 베어링 등가 마찰계수 μ=${driveAssumptions.bearingRollingMu.toFixed(3)} · 유효 반경 ${(m.bearingSide/2).toFixed(1)} mm · 보수적 NEMA17 유효 토크 ${driveAssumptions.usableNemaTorqueNm.toFixed(3)} N·m. 수평 1:1은 마찰 ${h.frictionNm.toFixed(3)} N·m와 가속 부하를 합산하며, 수직은 30:1 웜기어 효율 ${(driveAssumptions.wormEfficiency*100).toFixed(0)}%를 적용합니다.`;
  return {status,safe:status==='safe',stepsPerDegree:h.stepsPerDegree,resolution:1/h.stepsPerDegree,h,v};
}

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
  // Current production wiring: A0/A1 are the right pair and A2/A3 are the
  // left pair (top/bottom respectively).  Keep this map identical to the
  // physical CDS layout declared in the HALF4WIRE control sketch.
  state.pins={A0:cell(1,1),A1:cell(1,-1),A2:cell(-1,1),A3:cell(-1,-1)};
  state.ldr.left=(state.pins.A2+state.pins.A3)/2;state.ldr.right=(state.pins.A0+state.pins.A1)/2;state.ldr.top=(state.pins.A0+state.pins.A2)/2;state.ldr.bottom=(state.pins.A1+state.pins.A3)/2;
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
function makeStepper(name,stepPin,dirPin){const horizontal=/h$/i.test(name)||/horizontal/i.test(name),stepsPerDegree=133.333;const axis=horizontal?'H':'V';const stepper={name,stepPin:+stepPin,dirPin:+dirPin,position:0,target:0,maxSpeed:800,acceleration:500,setMaxSpeed(value){this.maxSpeed=+value||this.maxSpeed;},setAcceleration(value){this.acceleration=+value||this.acceleration;},moveTo(steps){this.target=+steps||0;},move(steps){this.target=this.position+(+steps||0);},currentPosition(){return this.position;},distanceToGo(){return this.target-this.position;},setCurrentPosition(steps){this.position=+steps||0;this.target=this.position;},run(){return this.runToPosition();},runToPosition(){const requested=clamp(Math.round(90+this.target/stepsPerDegree),20,160),nextH=horizontal?requested:state.h,nextV=horizontal?state.v:requested,collision=getCollisionState(nextH,nextV);if(!collision.safe){const key=`stepper-${axis}:${nextH}:${nextV}`;if(state.lastCollisionKey!==key){state.lastCollisionKey=key;serialPrint(`COLLISION BLOCKED: NEMA17-${axis} → ${requested}°`);}state.collision=collision;return false;}state.lastCollisionKey='';this.position=this.target;if(horizontal)state.h=requested;else state.v=requested;state.collision=collision;return true;}};state.steppers[name]=stepper;serialPrint(`${name}: NEMA17 STEP D${stepPin} / DIR D${dirPin}`);return stepper;}
function makeLcd(address){const key=address===0x26?'26':address===0x27?'27':String(address);const lcd={address,col:0,row:0,lines:['                ','                '],batch:false,lastLogged:'',init(){state.lcds[key]=this;},begin(){state.lcds[key]=this;},backlight(){},notify(){if(this.batch)return;const content=this.lines.join(' / ');if(content!==this.lastLogged){this.lastLogged=content;serialPrint(`[LCD 0x${this.address.toString(16).toUpperCase()}] ${this.lines[0].trim()} / ${this.lines[1].trim()}`);}},clear(){this.lines=['                ','                '];this.col=0;this.row=0;this.notify();},setCursor(col,row){this.col=clamp(Math.floor(+col||0),0,15);this.row=clamp(Math.floor(+row||0),0,1);},print(value,precision){let text;if(typeof value==='number'){text=Number.isInteger(precision)&&precision>=0?value.toFixed(precision):String(+value.toFixed(2));}else{text=String(value);}let line=this.lines[this.row];for(const char of text){if(this.col>=16)break;line=line.slice(0,this.col)+char+line.slice(this.col+1);this.col++;}this.lines[this.row]=line;this.notify();},write(value){this.print(typeof value==='number'?String.fromCharCode(value):value);},println(value,precision){this.print(value,precision);this.row=1;this.col=0;}};state.lcds[key]=lcd;return lcd;}
// Optional INA219 current/power monitor on the same virtual I²C bus (A4/A5).
// Values are derived from the physical panel model, just as the real sensor would observe them.
function makeIna219(address=0x40){return {address,ready:false,begin(){this.ready=true;serialPrint(`INA219.begin(0x${this.address.toString(16).toUpperCase()})`);return true;},success(){return this.ready;},getBusVoltage_V(){return state.voltage;},getShuntVoltage_mV(){return state.current*100;},getCurrent_mA(){return state.current*1000;},getPower_mW(){return state.power*1000;},getLoadVoltage_V(){return state.voltage+this.getShuntVoltage_mV()/1000;},setCalibration_32V_2A(){},setCalibration_32V_1A(){},setCalibration_16V_400mA(){}};}
// INA219 values are sampled from the existing PV model.  This does not alter
// the light, motor, or panel calculations; it only supplies the same values a
// 0.1-ohm-shunt INA219 would report through its Arduino API.
function sketchUsesIna219(source){return sourceDefineNumber(source,'USE_INA219',0)===1||/\bAdafruit_INA219\s+[A-Za-z_]\w*/.test(source);}
function beginInaTelemetry(source){if(!sketchUsesIna219(source)){state.inaTelemetry=null;return;}const now=Math.round(state.elapsed*1000);state.inaTelemetry={startedAt:now,lastSample:now,before:{v:0,i:0,p:0,n:0,done:false},after:{v:0,i:0,p:0,n:0,done:false},settledAt:null};state.beforePower=null;state.afterPower=null;state.increaseRate=null;serialPrint('INA219 virtual monitor enabled at 0x40 (A4/A5, R100)');}
function updateInaTelemetry(){const t=state.inaTelemetry;if(!t)return;const now=Math.round(state.elapsed*1000);if(now-t.lastSample<100)return;t.lastSample=now;const sample=target=>{target.v+=state.voltage;target.i+=state.current;target.p+=state.power;target.n++;};if(!t.before.done){sample(t.before);if(now-t.startedAt>=2000&&t.before.n){t.before.done=true;state.beforePower=t.before.p/t.before.n;serialPrint(`INA219 before average: ${state.beforePower.toFixed(2)}W`);}return;}const h=state.steppers.motor1,v=state.steppers.motor2,still=Math.abs(h?.velocity||0)<.01&&Math.abs(v?.velocity||0)<.01&&state.systemState!=='TRACKING'&&state.systemState!=='HORIZONTAL CONFIRM';if(!still){t.settledAt=null;t.after={v:0,i:0,p:0,n:0,done:false};return;}if(t.settledAt===null){t.settledAt=now;return;}sample(t.after);if(!t.after.done&&now-t.settledAt>=2000&&t.after.n){t.after.done=true;state.afterPower=t.after.p/t.after.n;state.increaseRate=state.beforePower>0?(state.afterPower-state.beforePower)*100/state.beforePower:0;serialPrint(`INA219 after average: ${state.afterPower.toFixed(2)}W (${state.increaseRate.toFixed(1)}%)`);}}
// Arduino String(value, decimals) compatibility for code typed in the editor.
// It keeps ordinary text intact and formats numeric values just like String(float, digits).
function arduinoString(value, decimals){if(typeof value==='number'&&Number.isInteger(decimals)&&decimals>=0)return value.toFixed(decimals);return String(value);}

// Advanced Uno profile ---------------------------------------------------------
// Supports the structured sketch used for the final project: enum-based phases,
// optional HOME switches, INA219 health checks, differential LCD writes and
// 64-bit-style micro-Wh energy accounting.  This keeps the simulation aligned
// with a full Arduino C++ sketch while the ordinary editor still accepts the
// lighter Arduino subset below.
function advancedProfileSource(source){return /enum\s+Phase\b/.test(source)&&/struct\s+PowerReading\b/.test(source)&&/\bupdateHoming\s*\(/.test(source)&&/\bwriteDiff\s*\(/.test(source);}
function sourceNumber(source,name,fallback){const constMatch=new RegExp(`(?:const\\s+)?(?:unsigned\\s+long|uint8_t|uint64_t|int8_t|int|float|double|long)\\s+${name}\\s*=\\s*([^;]+);`).exec(source),defineMatch=new RegExp(`^\\s*#define\\s+${name}\\s+([^\\s/]+)`, 'm').exec(source),raw=(constMatch?.[1]??defineMatch?.[1]??'').replace(/[fFuUlL]/g,'').trim();const value=Number(raw);return Number.isFinite(value)?value:fallback;}
function sourceBool(source,name,fallback=false){const match=new RegExp(`const\\s+bool\\s+${name}\\s*=\\s*(true|false)\\s*;`).exec(source);return match?match[1]==='true':fallback;}
function lcdDiffWrite(lcd,rows){lcd.batch=true;rows.forEach((row,index)=>{const next=String(row).slice(0,16).padEnd(16,' '),old=lcd.lines[index]||'                ';let pos=0;while(pos<16){if(old[pos]===next[pos]){pos++;continue;}const start=pos;while(pos<16&&old[pos]!==next[pos])pos++;lcd.setCursor(start,index);lcd.print(next.slice(start,pos));}});lcd.batch=false;lcd.notify();}
function createAdvancedController(source){
  const cfg={min:sourceNumber(source,'MIN_ANGLE',20),max:sourceNumber(source,'MAX_ANGLE',160),home:sourceNumber(source,'HOME_ANGLE',90),tolerance:sourceNumber(source,'LDR_TOLERANCE',35),step:sourceNumber(source,'TRACK_STEP_DEG',1),stable:sourceNumber(source,'STABLE_READS_REQUIRED',10),control:sourceNumber(source,'CONTROL_MS',100),lcd:sourceNumber(source,'LCD_MS',300),result:sourceNumber(source,'RESULT_PAGE_MS',3000),measure:sourceNumber(source,'MEASURE_SAMPLES',50),stabilize:sourceNumber(source,'STABILIZE_SAMPLES',300),timeout:sourceNumber(source,'TRACK_TIMEOUT_MS',120000),maxV:sourceNumber(source,'MAX_VALID_V',32),maxA:sourceNumber(source,'MAX_VALID_CURRENT_A',3.2),maxErrors:sourceNumber(source,'MAX_INA_ERRORS',3),stepsH:133.333,stepsV:133.333,useHome:sourceBool(source,'USE_HOME_SENSORS',false)};
  const h=makeStepper('motorH',2,3),v=makeStepper('motorV',4,5),lcd1=makeLcd(0x26),lcd2=makeLcd(0x27),ina=makeIna219(0x40);
  const c={phase:cfg.useHome?0:1,fault:0,targetH:cfg.home,targetV:cfg.home,errH:0,errV:0,sampleCount:0,stableCount:0,page:0,sumP:0,sumV:0,sumI:0,beforeP:0,afterP:0,afterV:0,afterI:0,rate:0,energyMicroWh:0,lastControl:0,lastEnergy:0,lastLcd:0,resultAt:0,trackAt:0,inaErrors:0,energyReady:false,lastDisplay:''};
  const angleSteps=(angle,axis)=>Math.round((angle-cfg.home)*(axis==='h'?cfg.stepsH:cfg.stepsV));
  const sync=()=>{Object.assign(state.scope,{phase:c.phase,targetH:c.targetH,targetV:c.targetV,errH:c.errH,errV:c.errV,sampleCount:c.sampleCount,stableCount:c.stableCount,page:c.page,beforeP:c.beforeP,afterP:c.afterP,afterV:c.afterV,afterI:c.afterI,rate:c.rate,energyMicroWh:c.energyMicroWh});state.beforePower=c.beforeP||null;state.afterPower=c.afterP||null;state.increaseRate=c.afterP&&c.beforeP?c.rate:null;state.energy=c.energyMicroWh/1000000;state.co2Kg=state.energy/1000*env().co2Factor;};
  const setH=angle=>{c.targetH=clamp(Math.round(angle),cfg.min,cfg.max);h.moveTo(angleSteps(c.targetH,'h'));};
  const setV=angle=>{c.targetV=clamp(Math.round(angle),cfg.min,cfg.max);v.moveTo(angleSteps(c.targetV,'v'));};
  const screen=(force=false)=>{const now=Math.round(state.elapsed*1000);if(!force&&now-c.lastLcd<cfg.lcd)return;c.lastLcd=now;let a0='BEFORE TRACK',a1='',b0='',b1='';if(c.phase===0){a0='HOMING';a1='MOVE TO 90 DEG';b0='POSITION SETUP';b1='MOTOR ACTIVE';}else if(c.phase===6){a0='SYSTEM ERROR';a1='MOTORS STOPPED';b0='SYSTEM ERROR';b1='CHECK LIMIT/INA';}else if(c.phase===1){a1='MEASURING...';b0='AFTER TRACK';b1='WAIT...';}else if(c.phase===2){a1=`P:${c.beforeP.toFixed(2)}W`;b0='TRACKING';b1=`H:${Math.round(c.errH)} V:${Math.round(c.errV)}`;}else if(c.phase===3){a1=`P:${c.beforeP.toFixed(2)}W`;b0='TRACK COMPLETE';b1='WAIT 30 SEC';}else if(c.phase===4){a1=`P:${c.beforeP.toFixed(2)}W`;b0='AFTER MEASURE';b1='MEASURING...';}else{a1=`P:${c.beforeP.toFixed(2)}W`;if(c.page===0){b0='AFTER POWER';b1=`${c.afterP.toFixed(2)}W ${c.rate.toFixed(1)}%`;}else if(c.page===1){b0='VOLT / CURRENT';b1=`${c.afterV.toFixed(2)}V ${c.afterI.toFixed(2)}A`;}else if(c.page===2){b0='ENERGY';b1=`${(c.energyMicroWh/1e6).toFixed(3)}Wh`;}else{b0='CO2 REDUCTION';b1=`${(c.energyMicroWh/1e6*.4541).toFixed(3)}g`;}}lcdDiffWrite(lcd1,[a0,a1]);lcdDiffWrite(lcd2,[b0,b1]);};
  const fault=code=>{if(c.phase===6)return;c.fault=code;c.phase=6;h.setCurrentPosition(h.currentPosition());v.setCurrentPosition(v.currentPosition());serialPrint(`FAULT ${code}`);sync();screen(true);};
  const targets=()=>{const tl=state.pins.A0,tr=state.pins.A1,bl=state.pins.A2,br=state.pins.A3;c.errH=(tl+bl)/2-(tr+br)/2;c.errV=(tl+tr)/2-(bl+br)/2;const hOk=Math.abs(c.errH)<=cfg.tolerance,vOk=Math.abs(c.errV)<=cfg.tolerance;let hLimit=false,vLimit=false;if(!hOk&&h.distanceToGo()===0){const next=c.targetH+(c.errH>0?-cfg.step:cfg.step);if(next<cfg.min||next>cfg.max)hLimit=true;else setH(next);}if(!vOk&&v.distanceToGo()===0){const next=c.targetV+(c.errV>0?cfg.step:-cfg.step);if(next<cfg.min||next>cfg.max)vLimit=true;else setV(next);}return {aligned:hOk&&vOk,hLimit,vLimit};};
  const read=()=>{const voltage=state.voltage,current=state.current,power=voltage*current;return {valid:Number.isFinite(voltage)&&Number.isFinite(current)&&voltage>=0&&voltage<=cfg.maxV&&current>=-cfg.maxA&&current<=cfg.maxA&&Number.isFinite(power)&&power>=0,voltage,current:Math.max(0,current),power:Math.max(0,power)};};
  return {setup(){ina.begin();lcd1.init();lcd1.backlight();lcd2.init();lcd2.backlight();h.setMaxSpeed(sourceNumber(source,'MAX_SPEED_H',420));h.setAcceleration(sourceNumber(source,'ACCEL_H',260));v.setMaxSpeed(sourceNumber(source,'MAX_SPEED_V',320));v.setAcceleration(sourceNumber(source,'ACCEL_V',200));h.setCurrentPosition(cfg.useHome?angleSteps(cfg.min,'h'):0);v.setCurrentPosition(cfg.useHome?angleSteps(cfg.min,'v'):0);if(cfg.useHome){setH(cfg.home);setV(cfg.home);}c.lastControl=Math.round(state.elapsed*1000);c.lastEnergy=c.lastControl;sync();screen(true);},loop(){const now=Math.round(state.elapsed*1000);if(c.phase===0){h.run();v.run();if(h.distanceToGo()===0&&v.distanceToGo()===0){c.phase=1;c.sampleCount=0;screen(true);}}else if(c.phase!==6){h.run();v.run();}if(c.phase===6){sync();return;}if(now-c.lastControl<cfg.control){screen(false);return;}c.lastControl=now;const r=read();if(c.energyReady){const increment=r.power*(now-c.lastEnergy)/3.6;if(r.valid&&increment>0)c.energyMicroWh+=Math.round(increment);}else c.energyReady=true;c.lastEnergy=now;if(!r.valid){c.inaErrors++;if(c.inaErrors>=cfg.maxErrors)fault('INA_READ');sync();return;}c.inaErrors=0;if(c.phase===1){c.sumP+=r.power;c.sampleCount++;if(c.sampleCount>=cfg.measure){c.beforeP=c.sumP/c.sampleCount;c.sumP=0;c.sampleCount=0;c.phase=2;c.trackAt=now;screen(true);}}else if(c.phase===2){if(now-c.trackAt>=cfg.timeout){fault('TRACK_TIMEOUT');return;}const status=targets();if(status.hLimit||status.vLimit){fault(status.hLimit&&status.vLimit?'HV_LIMIT':status.hLimit?'H_LIMIT':'V_LIMIT');return;}c.stableCount=status.aligned&&h.distanceToGo()===0&&v.distanceToGo()===0?c.stableCount+1:0;if(c.stableCount>=cfg.stable){c.phase=3;c.sampleCount=0;screen(true);}}else if(c.phase===3){const status=targets();if(!status.aligned||status.hLimit||status.vLimit){c.phase=2;c.stableCount=0;c.sampleCount=0;c.trackAt=now;screen(true);}else if(++c.sampleCount>=cfg.stabilize){c.phase=4;c.sampleCount=0;c.sumP=c.sumV=c.sumI=0;screen(true);}}else if(c.phase===4){c.sumP+=r.power;c.sumV+=r.voltage;c.sumI+=r.current;c.sampleCount++;if(c.sampleCount>=cfg.measure){c.afterP=c.sumP/c.sampleCount;c.afterV=c.sumV/c.sampleCount;c.afterI=c.sumI/c.sampleCount;c.rate=c.beforeP>.01?(c.afterP-c.beforeP)*100/c.beforeP:0;c.phase=5;c.sampleCount=0;c.page=0;c.resultAt=now;screen(true);}}else if(c.phase===5&&now-c.resultAt>=cfg.result){c.resultAt=now;c.page=(c.page+1)%4;screen(true);}sync();screen(false);}};
}
function compileAdvancedControlSketch(source){try{state.scope=Object.create(null);state.servos={};state.pinServos={};state.steppers={};state.lcds={};state.auto=null;const controller=createAdvancedController(source);state.advancedController=controller;state.compiled={setup:()=>controller.setup(),loop:()=>controller.loop()};state.loopDelay=.02;state.compiled.setup();state.compiled.loop();renderAll();setMessage('고급 제어 코드 적용 성공 — 상태기계·홈센서·차등 LCD 프로파일을 실행합니다.','ok');return true;}catch(error){state.running=false;setMessage(`고급 코드 오류: ${error.message}`,'error');serialPrint(`ADVANCED ERROR: ${error.message}`);return false;}}

// Revised production tracker: AM-CS2 + L298N are driven as AccelStepper
// HALF4WIRE axes.  This recognizes the supplied non-blocking, horizontal
// hysteresis sketch and mirrors its actual pins, limits and LCD behaviour.
function scanUnoHalfWireSketch(source){const numbers={};source.replace(/^\s*#define\s+([A-Za-z_]\w*)\s+([\d.]+)/gm,(_,name,value)=>(numbers[name]=Number(value),''));source.replace(/(?:const\s+)?(?:unsigned\s+long|uint8_t|int8_t|int|long|float|double)\s+([A-Za-z_]\w*)\s*=\s*([\d.]+)[fFuUlL]*\s*;/g,(_,name,value)=>(numbers[name]=Number(value),''));const value=token=>{const text=String(token).trim().replace(/([0-9.])[fFuUlL]+$/,'$1');const direct=Number(text);return Number.isFinite(direct)?direct:(Number.isFinite(numbers[text])?numbers[text]:NaN);};const steppers=[],re=/AccelStepper\s+([A-Za-z_]\w*)\s*\(\s*AccelStepper::HALF4WIRE\s*,\s*([^,()]+)\s*,\s*([^,()]+)\s*,\s*([^,()]+)\s*,\s*([^,()]+)\s*\)/g;let match;while((match=re.exec(source))){const pins=match.slice(2).map(value);steppers.push({name:match[1],pins,valid:pins.every(pin=>Number.isInteger(pin)&&pin>=0&&pin<=13)});}const lcds=[];source.replace(/LiquidCrystal_I2C\s+([A-Za-z_]\w*)\s*\(\s*(0x[\da-fA-F]+|\d+)/g,(_,name,address)=>(lcds.push({name,address:Number(address)}),''));return {steppers,lcds};}
function half4WireTrackingProfileSource(source){const profile=scanUnoHalfWireSketch(source);return profile.steppers.length>=2&&profile.lcds.some(lcd=>lcd.address===0x26)&&profile.lcds.some(lcd=>lcd.address===0x27)&&/\banalogRead\s*\(/.test(source)&&/\bvoid\s+setup\s*\(/.test(source)&&/\bvoid\s+loop\s*\(/.test(source);}
function sourceDefineNumber(s,n,f){const m=new RegExp(`#define\\s+${n}\\s+([\\d.]+)`).exec(s);return m&&Number.isFinite(+m[1])?+m[1]:f;}
function makeHalfWireStepper(name,pins,axis,gear){
  const spd=400*gear/360,h=axis==='H',m={name,pins,position:0,target:0,maxSpeed:80,acceleration:120,velocity:0,lastRun:state.elapsed,
    setMaxSpeed(v){this.maxSpeed=Math.max(1,+v||this.maxSpeed);},setAcceleration(v){this.acceleration=Math.max(1,+v||this.acceleration);},
    moveTo(v){this.target=+v||0;},move(v){this.target=this.position+(+v||0);},stop(){this.target=this.position;this.velocity=0;},currentPosition(){return Math.round(this.position);},distanceToGo(){return Math.round(this.target-this.position);},
    setCurrentPosition(v){this.position=+v||0;this.target=this.position;this.velocity=0;this.lastRun=state.elapsed;if(h)state.h=90+this.position/spd;else state.v=90+this.position/spd;},
    run(){const now=state.elapsed,d=Math.max(0,now-this.lastRun),gap=this.target-this.position;this.lastRun=now;if(Math.abs(gap)<.01){this.velocity=0;return false;}const axisLoad=mechanicalAxisDynamics(axis,gear,this.acceleration),accel=Math.max(1,axisLoad.effectiveAcceleration),wanted=Math.sign(gap)*this.maxSpeed;this.velocity+=clamp(wanted-this.velocity,-accel*d,accel*d);let delta=this.velocity*d;if(Math.abs(delta)>=Math.abs(gap)){delta=gap;this.velocity=0;}const next=this.position+delta,angle=clamp(90+next/spd,20,160),nh=h?angle:state.h,nv=h?state.v:angle,collision=getCollisionState(nh,nv);if(!collision.safe){this.stop();state.collision=collision;return false;}this.position=next;state.collision=collision;if(h)state.h=angle;else state.v=angle;return true;}
  };state.steppers[name]=m;serialPrint(`${name}: HALF4WIRE D${pins.join('/D')}`);return m;
}
function createHalf4WireTrackingController(s){const n=(name,f)=>sourceNumber(s,name,f),cfg={high:sourceBool(s,'BRIGHTER_IS_HIGH',true),hs:n('H_LEFT_SIGN',-1),vs:n('V_TOP_SIGN',1),gh:n('GEAR_RATIO_1',1),gv:n('GEAR_RATIO_2',30),hm:n('H_MAX_DEG',90),vm:n('V_MAX_DEG',15),hstop:n('H_LIGHT_STOP',40),hstart:n('H_LIGHT_START',65),confirm:n('H_CONFIRM_MS',250),prestop:n('H_PRESTOP_MS',100),alpha:n('H_FILTER_ALPHA',.35),vstop:n('V_LIGHT_STOP',35),vstart:n('V_LIGHT_START',45),min:n('MIN_LIGHT',60),sensor:n('SENSOR_MS',25),lcd:n('LCD_MS',350),serial:n('SERIAL_MS',1000),useIna:sourceDefineNumber(s,'USE_INA219',0)===1};const h=makeHalfWireStepper('motor1',[2,4,3,5],'H',cfg.gh),v=makeHalfWireStepper('motor2',[6,7,8,9],'V',cfg.gv),lcd1=makeLcd(0x26),lcd2=makeLcd(0x27),ina=makeIna219(0x40),c={cds:[0,0,0,0],eh:0,ev:0,fh:0,init:false,pending:0,since:0,dh:0,dv:0,light:0,maxH:0,maxV:0,lastSensor:0,lastLcd:0,lastSerial:0,lastPower:0,lastEnergy:0,ready:false,energy:0,voltage:0,current:0,power:0,start:0};const toSteps=(d,g)=>Math.round(d*400*g/360),toDeg=(p,g)=>Math.round(p*360/(400*g));const sync=()=>{Object.assign(state.scope,{motor1:h,motor2:v,cds:c.cds,errorH:c.eh,errorV:c.ev,filteredErrorH:c.fh,directionH:c.dh,directionV:c.dv,lightLevel:c.light,energyWh:c.energy,voltageV:c.voltage,currentA:c.current,powerW:c.power});state.energy=c.energy;state.co2Kg=c.energy/1000*env().co2Factor;state.systemState=c.light<cfg.min?'LOW LIGHT HOLD':c.dh===0&&c.dv===0?'LIGHT BALANCED':c.pending?'HORIZONTAL CONFIRM':'TRACKING';};const read=()=>{const b=[state.pins.A0,state.pins.A1,state.pins.A2,state.pins.A3].map(x=>cfg.high?x:1023-x);c.cds=[state.pins.A0,state.pins.A1,state.pins.A2,state.pins.A3];const left=(b[2]+b[3])/2,right=(b[0]+b[1])/2,top=(b[0]+b[2])/2,bottom=(b[1]+b[3])/2,raw=left-right;c.fh=c.init?c.fh+cfg.alpha*(raw-c.fh):raw;c.init=true;c.eh=Math.round(c.fh);c.ev=Math.round(top-bottom);c.light=Math.round(b.reduce((a,x)=>a+x,0)/4);};const choose=(e,sign,old,stop,start)=>{const mag=Math.abs(e);if(c.light<cfg.min||mag<=stop)return 0;const wanted=e>0?sign:-sign;return old!==wanted?(mag>=start?wanted:0):old;};const apply=(motor,wanted,key,limit)=>{if(wanted===c[key])return;if(wanted>0)motor.moveTo(limit);else if(wanted<0)motor.moveTo(-limit);else motor.stop();c[key]=wanted;};const tracking=now=>{const wanted=choose(c.eh,cfg.hs,c.dh,cfg.hstop,cfg.hstart);if(!wanted){c.pending=0;apply(h,0,'dh',c.maxH);}else if(wanted===c.dh)c.pending=0;else if(wanted!==c.pending){c.pending=wanted;c.since=now;}else{const elapsed=now-c.since;if(elapsed>=cfg.prestop&&c.dh)apply(h,0,'dh',c.maxH);if(elapsed>=cfg.confirm){apply(h,wanted,'dh',c.maxH);c.pending=0;}}apply(v,choose(c.ev,cfg.vs,c.dv,cfg.vstop,cfg.vstart),'dv',c.maxV);};const screen=now=>{const l=(lcd,rows)=>lcdDiffWrite(lcd,rows),num=x=>String(x).padStart(4,'0');l(lcd1,[`1:${num(c.cds[0])} 2:${num(c.cds[1])}`,`3:${num(c.cds[2])} 4:${num(c.cds[3])}`]);let line=c.light<cfg.min?'LOW LIGHT HOLD':c.dh===0&&c.dv===0?'LIGHT BALANCED':`E:${c.eh>=0?'+':''}${c.eh},${c.ev>=0?'+':''}${c.ev}`;if(cfg.useIna&&c.ready){const p=Math.floor(now/4000)%5;if(p===1)line=`V:${c.voltage.toFixed(1)} I:${c.current.toFixed(3)}`;if(p===2)line=`W:${c.power.toFixed(2)} S:${c.start.toFixed(2)}`;if(p===3)line=`ENERGY:${c.energy.toFixed(3)}Wh`;if(p===4)line=`CO2 EST:${(c.energy*.4541).toFixed(3)}g`;}l(lcd2,[`H:${toDeg(h.currentPosition(),cfg.gh)>=0?'+':''}${String(toDeg(h.currentPosition(),cfg.gh)).padStart(3,'0')} V:${toDeg(v.currentPosition(),cfg.gv)>=0?'+':''}${String(toDeg(v.currentPosition(),cfg.gv)).padStart(3,'0')}`,line]);};const power=now=>{if(!cfg.useIna||!c.ready||now-c.lastPower<500)return;c.lastPower=now;c.voltage=state.voltage;c.current=Math.max(0,state.current);c.power=c.voltage*c.current;if(c.lastEnergy&&c.power>0)c.energy+=c.power*(now-c.lastEnergy)/3600000;c.lastEnergy=now;};return{setup(){lcd1.init();lcd1.backlight();lcd2.init();lcd2.backlight();h.setMaxSpeed(n('MAX_SPEED_1',66.67));v.setMaxSpeed(n('MAX_SPEED_2',133.33));h.setCurrentPosition(0);v.setCurrentPosition(0);c.maxH=toSteps(cfg.hm,cfg.gh);c.maxV=toSteps(cfg.vm,cfg.gv);state.energy=0;state.co2Kg=0;if(cfg.useIna){c.ready=ina.begin();c.start=state.power;}read();tracking(Math.round(state.elapsed*1000));screen(0);sync();serialPrint('TOP CDS / H STABLE TRACKING START');},loop(){h.run();v.run();const now=Math.round(state.elapsed*1000);if(now-c.lastSensor>=cfg.sensor){c.lastSensor=now;read();tracking(now);}power(now);if(now-c.lastLcd>=cfg.lcd){c.lastLcd=now;screen(now);}if(now-c.lastSerial>=cfg.serial){c.lastSerial=now;serialPrint(`CDS1~4: ${c.cds.join(' ')} | ERR H,V:${c.eh},${c.ev}`);}h.run();v.run();sync();}};}
function compileHalf4WireTrackingSketch(source){try{const normalized=sketchUsesIna219(source)&&sourceDefineNumber(source,'USE_INA219',0)!==1?`${source}\n#define USE_INA219 1`:source;state.scope=Object.create(null);state.servos={};state.pinServos={};state.steppers={};state.lcds={};state.auto=null;state.pagedLcd=null;const controller=createHalf4WireTrackingController(normalized);state.advancedController=controller;state.compiled={setup:()=>controller.setup(),loop:()=>controller.loop()};state.loopDelay=.02;state.compiled.setup();state.steppers.motor1?.setAcceleration(sourceNumber(normalized,'ACCELERATION_1',44.44));state.steppers.motor2?.setAcceleration(sourceNumber(normalized,'ACCELERATION_2',350));beginInaTelemetry(normalized);configurePagedLcdProfile(normalized);state.compiled.loop();updatePagedLcdProfile();renderAll();setMessage(state.pagedLcd?'HALF4WIRE 코드 적용 성공 — INA219/LCD 2페이지를 2초마다 갱신합니다.':'HALF4WIRE 제어 코드 적용 성공 — 수평 안정화·수직 추적·LCD를 실행합니다.','ok');return true;}catch(error){state.running=false;setMessage(`HALF4WIRE 코드 오류: ${error.message}`,'error');serialPrint(`HALF4WIRE ERROR: ${error.message}`);return false;}}

// The restored production sketch has two LCD pages and flips lcdPage every
// PAGE_MS. The lightweight HALF4WIRE interpreter previously ran the motors
// but discarded that display state, leaving the first screen permanently on.
// The physical sketch may toggle with either `lcdPage ^= 1` or the equally
// valid `lcdPage = (uint8_t)(1 - lcdPage)`.  Detect the two-page LCD design,
// not one particular C/C++ spelling of that toggle.
function pagedLcdProfileSource(source){return half4WireTrackingProfileSource(source)&&/\bPAGE_MS\b/.test(source)&&/\blcdPage\b/.test(source);}
function configurePagedLcdProfile(source){
  if(!pagedLcdProfileSource(source)){state.pagedLcd=null;return;}
  const now=Math.round(state.elapsed*1000);
  state.pagedLcd={page:0,startedAt:now,pageMs:sourceNumber(source,'PAGE_MS',2000),useIna:sketchUsesIna219(source),layout:/\bERROR\s+H\s*:/.test(source)&&/\bLIGHT\s*:/.test(source)?'sensor-status':'power-sensor',lastPage:-1};
  state.scope.lcdPage=0;
}
function updatePagedLcdProfile(){
  const profile=state.pagedLcd,lcd1=state.lcds['26'],lcd2=state.lcds['27'];
  if(!profile||!lcd1||!lcd2)return;
  const now=Math.round(state.elapsed*1000),page=Math.floor(Math.max(0,now-profile.startedAt)/Math.max(1,profile.pageMs))%2;
  if(page!==profile.page){profile.page=page;state.scope.lcdPage=page;serialPrint(`LCD page ${page+1}/2 displayed`);}
  const pad=value=>String(Math.round(value)).padStart(4,'0'),signed=value=>`${value>=0?'+':''}${String(Math.round(value)).padStart(3,'0')}`;
  const errorText=value=>`${value>=0?'+':'-'}${String(Math.abs(Math.round(value))).padStart(5,'0')}`;
  const h=Math.round(state.h-90),v=Math.round(state.v-90),hMotion=Math.abs(state.steppers.motor1?.velocity||0)>.01?'MOVE':'IDLE',vMotion=Math.abs(state.steppers.motor2?.velocity||0)>.01?'MOVE':'IDLE';
  const light=Math.round((state.pins.A0+state.pins.A1+state.pins.A2+state.pins.A3)/4);
  const errorH=Math.round(state.ldr.left-state.ldr.right),errorV=Math.round(state.ldr.top-state.ldr.bottom);
  if(profile.layout==='sensor-status'){
    if(page===0){
      lcdDiffWrite(lcd1,[`RT:${pad(state.pins.A0)} RB:${pad(state.pins.A1)}`,`LT:${pad(state.pins.A2)} LB:${pad(state.pins.A3)}`]);
      lcdDiffWrite(lcd2,[`H:${signed(h)} V:${signed(v)}`,light<60?'LOW LIGHT HOLD':`H:${hMotion} V:${vMotion}`]);
    }else{
      lcdDiffWrite(lcd1,[`ERROR H:${errorText(errorH)}`,`ERROR V:${errorText(errorV)}`]);
      lcdDiffWrite(lcd2,[`LIGHT:${pad(light)}`,light<60?'LOW LIGHT HOLD':`H:${hMotion} V:${vMotion}`]);
    }
    return;
  }
  if(page===0){
    if(profile.useIna){const after=state.afterPower===null?'MEASURING':`${state.afterPower.toFixed(2)}W`,rate=state.increaseRate===null?`BEF:${state.beforePower===null?'MEAS':state.beforePower.toFixed(2)+'W'}`:`UP:${state.increaseRate.toFixed(1)}%`;lcdDiffWrite(lcd1,[`V:${state.voltage.toFixed(2)} I:${(state.current*1000).toFixed(0)}mA`,`P:${state.power.toFixed(2)}W E:${state.energy.toFixed(2)}`]);lcdDiffWrite(lcd2,[`AF:${after}`,rate]);}
    else{lcdDiffWrite(lcd1,['V:N/A I:N/A','P:N/A E:N/A']);lcdDiffWrite(lcd2,['B:N/A A:N/A','dP:N/A  RATE:N/A']);}
  }else{
    lcdDiffWrite(lcd1,[`RT:${pad(state.pins.A0)} RB:${pad(state.pins.A1)}`,`LT:${pad(state.pins.A2)} LB:${pad(state.pins.A3)}`]);
    lcdDiffWrite(lcd2,[`H:${signed(h)} V:${signed(v)}`,`H:${hMotion} V:${vMotion}`]);
  }
}

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
function compileSketchCore(){try{const source=$('codeEditor').value;if(!/void\s+setup\s*\(/.test(source)||!/void\s+loop\s*\(/.test(source))throw new Error('void setup()과 void loop()이 모두 필요합니다.');if(half4WireTrackingProfileSource(source))return compileHalf4WireTrackingSketch(source);if(advancedProfileSource(source))return compileAdvancedControlSketch(source);
  const functions=extractAllFunctions(source);if(!functions.some(fn=>fn.name==='setup')||!functions.some(fn=>fn.name==='loop'))throw new Error('setup()과 loop()을 찾을 수 없습니다.');const globals=removeFunctionRanges(source,functions).replace(/^\s*#.*$/gm,'').replace(/\/\/.*$/gm,'');state.scope=Object.create(null);state.servos={};state.pinServos={};state.steppers={};state.lcds={};state.auto=null;state.pagedLcd=null;state.advancedController=null;
  globals.replace(/\bAdafruit_INA219\s+([A-Za-z_]\w*)\s*(?:\(\s*(0x[\da-fA-F]+|\d+)\s*\))?\s*;/g,(_,name,address)=>{state.scope[name]=makeIna219(address===undefined?0x40:Number(address));return '';});
  globals.replace(/\bAccelStepper\s+([A-Za-z_]\w*)\s*\(\s*AccelStepper::DRIVER\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*;/g,(_,name,stepPin,dirPin)=>{state.scope[name]=makeStepper(name,stepPin,dirPin);return '';});
  globals.replace(/\bServo\s+([A-Za-z_]\w*)\s*;/g,(_,name)=>{state.scope[name]=makeServo(name);return '';});
  globals.replace(/\bLiquidCrystal_I2C\s+([A-Za-z_]\w*)\s*\(\s*(0x[\da-fA-F]+|\d+)[^)]*\)\s*;/g,(_,name,address)=>{state.scope[name]=makeLcd(Number(address));return '';});
  globals.replace(/\b(?:const\s+)?(?:unsigned\s+long|int|float|double|long|bool|boolean)\s+([^;]+);/g,(_,declarations)=>{declarations.split(',').forEach(declaration=>{const match=/^\s*([A-Za-z_]\w*)\s*(?:=\s*(.+))?\s*$/.exec(declaration);if(!match)return;const[,name,raw]=match;state.scope[name]=raw?Number(Function('scope',`with(scope){return (${raw})}`)(state.scope)):0;});return '';});
  const api={A0,A1,A2,A3,A4,A5,HIGH:1,LOW:0,INPUT:0,OUTPUT:1,Math,String:arduinoString,analogRead:pin=>state.pins[`A${pin}`]??0,constrain:(n,lo,hi)=>clamp(+n,+lo,+hi),abs:Math.abs,min:Math.min,max:Math.max,round:Math.round,map:(x,a,b,c,d)=>(x-a)*(d-c)/(b-a)+c,delay:ms=>{state.loopDelay=Math.max(.01,(+ms||0)/1000);},millis:()=>Math.round(state.elapsed*1000),readPower:()=>state.power,readVoltage:()=>state.voltage,readCurrent:()=>state.current,readEnergyWh:()=>state.energy,readCO2Grams:()=>state.co2Kg*1000,setSystemState:value=>{state.systemState=String(value);},setBeforePower:value=>{state.beforePower=+value;},setAfterPower:value=>{state.afterPower=+value;},setPowerComparison:(before,after)=>{state.beforePower=+before;state.afterPower=+after;state.increaseRate=before?((after-before)/before)*100:0;},beginAutoTracking,runAutoTracking,Serial:{begin(){},print:serialPrint,println:serialPrint},pinMode(){},digitalWrite(){}};
  Object.assign(state.scope,api);const functionSource=functions.map(fn=>`function ${fn.name}(${jsParams(fn.params)}){${transform(fn.body)}}`).join('\n');state.compiled=new Function('scope',`with(scope){${functionSource}\nreturn {setup,loop};}`)(state.scope);state.loopDelay=.18;state.compiled.setup();state.compiled.loop();renderAll();setMessage('컴파일 성공 — setup()과 사용자 함수를 준비했습니다.','ok');return true;
}catch(error){state.running=false;setMessage(`컴파일 오류: ${error.message}`,'error');serialPrint(`ERROR: ${error.message}`);return false;}}
function unoCompatibility(source){const profile=scanUnoHalfWireSketch(source),errors=[],warnings=[],headers=[...source.matchAll(/^\s*#include\s*[<"]([^>"]+)[>"]/gm)].map(match=>match[1]),supported=['Wire.h','AccelStepper.h','LiquidCrystal_I2C.h','Adafruit_INA219.h','Servo.h','stdio.h','stdlib.h'];headers.filter(header=>!supported.includes(header)).forEach(header=>warnings.push(`미지원 헤더: ${header}`));if(profile.steppers.length){if(profile.steppers.length!==2)errors.push(`HALF4WIRE 모터가 ${profile.steppers.length}개입니다. 이 모형은 수평·수직 2개가 필요합니다.`);if(profile.steppers.some(stepper=>!stepper.valid))errors.push('스텝모터 핀은 Uno D0–D13 숫자 또는 숫자 상수여야 합니다.');const pins=profile.steppers.flatMap(stepper=>stepper.pins);if(new Set(pins).size!==pins.length)errors.push('두 모터의 코일 핀이 겹칩니다. 배선을 분리하세요.');}if(/LiquidCrystal_I2C/.test(source)){if(!profile.lcds.some(lcd=>lcd.address===0x26))errors.push('LCD1 주소 0x26을 찾지 못했습니다.');if(!profile.lcds.some(lcd=>lcd.address===0x27))errors.push('LCD2 주소 0x27을 찾지 못했습니다.');}if(/Adafruit_INA219/.test(source)&&!/\bina\w*\.begin\s*\(/i.test(source))warnings.push('INA219 객체의 begin() 호출을 확인하세요.');if(profile.steppers.length>=2&&/\banalogRead\s*\(/.test(source)&&errors.length===0)warnings.push('브라우저 기구 모델 적용 가능 · 실제 업로드 전 Arduino IDE의 Uno 컴파일이 필요합니다.');return {profile,errors,warnings,headers};}
function renderUnoCompatibility(source){const report=unoCompatibility(source),box=$('unoCheck');if(!box)return report;const motors=report.profile.steppers.length,lcds=report.profile.lcds.map(lcd=>`0x${lcd.address.toString(16).toUpperCase()}`).join(', ')||'없음';const detail=`Uno 검사 · HALF4WIRE ${motors}개 · LCD ${lcds} · A0–A3 ${/\banalogRead\s*\(/.test(source)?'확인':'미확인'}`;box.className=`uno-check ${report.errors.length?'error':report.warnings.length?'warn':'ok'}`;box.textContent=report.errors.length?`${detail} · 차단: ${report.errors.join(' / ')}`:`${detail} · ${report.warnings.join(' / ')||'보드 배선·I²C 선언 확인'}`;return report;}
function compileSketch(){const source=$('codeEditor').value,report=renderUnoCompatibility(source);if(report.errors.length){state.running=false;setMessage(`Uno 배선/선언 오류: ${report.errors[0]}`,'error');serialPrint(`UNO CHECK ERROR: ${report.errors.join(' | ')}`);return false;}const compiled=compileSketchCore();if(compiled&&!half4WireTrackingProfileSource(source)&&!advancedProfileSource(source))beginInaTelemetry(source);return compiled;}
function runLoop(){if(!state.compiled){if(!compileSketch())return;}try{state.loopDelay=.02;state.compiled.loop();}catch(error){state.running=false;setMessage(`실행 오류: ${error.message}`,'error');serialPrint(`RUNTIME ERROR: ${error.message}`);}}
function resetBoard(){state.running=false;state.compiled=null;state.advancedController=null;state.scope={};state.h=90;state.v=90;state.energy=0;state.co2Kg=0;state.elapsed=0;state.loopDelay=.18;state.nextLoop=0;state.servos={};state.pinServos={};state.steppers={};state.lcds={};state.auto=null;state.pagedLcd=null;state.inaTelemetry=null;state.systemState='IDLE';state.beforePower=null;state.afterPower=null;state.increaseRate=null;state.serial=[];serialPrint('Board reset: NEMA17-H/V → 90°, LCD buffers cleared');setMessage('보드를 초기화했습니다. 컴파일·적용을 눌러 새 코드를 실행하세요.');updateEnvironment();renderAll();}
function lcdText(key){return state.lcds[key]?state.lcds[key].lines:['                ','                '];}
function syncGraduationSketchTelemetry(){const s=state.scope,phase=Number.isFinite(+s.phase)?+s.phase:+s.step;if(!Number.isFinite(phase))return;const steps=state.advancedController?['HOMING','BEFORE MEASURE','TRACKING','STABILIZING','AFTER MEASURE','RESULT','ERROR']:['BEFORE MEASURE','TRACKING','STABILIZING','AFTER MEASURE','RESULT'];state.systemState=steps[clamp(Math.floor(phase||0),0,steps.length-1)];const beforePhase=state.advancedController?2:1,afterPhase=state.advancedController?5:4;if(phase>=beforePhase&&Number.isFinite(+s.beforeP))state.beforePower=+s.beforeP;if(phase>=afterPhase&&Number.isFinite(+s.afterP)){state.afterPower=+s.afterP;state.increaseRate=Number.isFinite(+s.rate)?+s.rate:null;}}
function setVerificationStatus(id,status,text){const item=$(id);item.textContent=text;item.className=status;}
function updateDesignVerification(){syncGraduationSketchTelemetry();const voltage=state.voltage,current=state.current,power=state.power,calculated=voltage*current,delta=Math.abs(calculated-power),factor=env().co2Factor,carbonG=state.energy*factor,drive=updateTorqueSimulation(),collision=updateCollisionSimulation();const compiled=!!state.compiled,hMotor=state.steppers.motorH,vMotor=state.steppers.motorV,servoReady=!!hMotor&&!!vMotor&&hMotor!==vMotor&&drive.safe,collisionSafe=collision.safe;const ldrReady=compiled&&/analogRead\s*\(\s*A[0-3]\s*\)/.test($('codeEditor').value);const lcdReady=!!state.lcds['26']&&!!state.lcds['27']&&state.lcds['26']!==state.lcds['27'];const mathReady=delta<.0001&&state.energy>=0&&Number.isFinite(carbonG);$('verifyPowerFormula').textContent=`${voltage.toFixed(2)} V × ${current.toFixed(3)} A = ${calculated.toFixed(3)} W`;$('verifyPowerDelta').textContent=`INA219 모델 전력 ${power.toFixed(3)} W · 오차 ${delta.toFixed(5)} W`;$('verifyCarbonFormula').textContent=`${state.energy.toFixed(3)} Wh × ${factor.toFixed(4)} g/Wh = ${carbonG.toFixed(3)} g`;setVerificationStatus('verifyServo',servoReady?'pass':compiled?'fail':'wait',servoReady?'PASS · STEP/DIR D2–D5':'대기');setVerificationStatus('verifyCollision',collisionSafe?'pass':'fail',collisionSafe?'PASS · 간섭 없음':'충돌 감지');setVerificationStatus('verifyLdr',ldrReady?'pass':compiled?'fail':'wait',ldrReady?'PASS · A0–A3':'대기');setVerificationStatus('verifyLcd',lcdReady?'pass':compiled?'fail':'wait',lcdReady?'PASS · 0x26/0x27':'대기');setVerificationStatus('verifyMath',mathReady?'pass':'fail',mathReady?'PASS · P=V×I':'오차 확인');const s=state.scope,phase=Number.isFinite(+s.phase)?s.phase:s.step,count=s.sampleCount??s.count;const stepInfo=Number.isFinite(+phase)?`phase ${phase} · count ${count||0} · H ${s.errH??'—'} · V ${s.errV??'—'}`:'코드 적용 전';$('verifyEvidence').textContent=compiled?`${stepInfo} · NEMA17-H ${state.h}° · NEMA17-V ${state.v}° · 30:1 worm · ${collisionSafe?'clear':'collision'}`:'코드를 컴파일·적용하면 NEMA17-H/V, LCD, 전력 산정 및 기구 간섭을 검사합니다.';return {compiled,servoReady,collisionSafe,ldrReady,lcdReady,mathReady};}
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
// Mechanical assembly renderer — rebuilt solely from the user's reference
// image and movement description.  It intentionally does not reuse any of the
// earlier temporary upper-frame geometry.
function drawRig(){
  const canvas=$('rigCanvas'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,m=mechanics();
  const e=env(),yaw=viewer.yaw,pitch=viewer.pitch,displayH=state.h.toFixed(2),displayV=state.v.toFixed(2);
  ctx.clearRect(0,0,w,h);ctx.fillStyle='#071b24';ctx.fillRect(0,0,w,h);
  const camera=([x,y,z])=>{const cy=Math.cos(yaw),sy=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch),rx=x*cy+z*sy,rz=-x*sy+z*cy;return [rx,y*cp-rz*sp,y*sp+rz*cp];};
  const project=point=>{const q=camera(point),s=viewer.zoom*720/(720+q[2]);return {x:w*.5+q[0]*s,y:h*.79-q[1]*s,z:q[2],s};};
  const poly=(points,fill,stroke='#496a70')=>{const p=points.map(project);ctx.fillStyle=fill;ctx.strokeStyle=stroke;ctx.lineWidth=1.25;ctx.beginPath();ctx.moveTo(p[0].x,p[0].y);p.slice(1).forEach(q=>ctx.lineTo(q.x,q.y));ctx.closePath();ctx.fill();ctx.stroke();};
  const line=(a,b,color,width=2,dash=[])=>{const p=project(a),q=project(b);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();ctx.setLineDash([]);};
  const box=(center,size,top,side,transform=point=>point)=>{const [x,y,z]=center,[a,b,c]=size.map(v=>v/2),v=[[x-a,y-b,z-c],[x+a,y-b,z-c],[x+a,y+b,z-c],[x-a,y+b,z-c],[x-a,y-b,z+c],[x+a,y-b,z+c],[x+a,y+b,z+c],[x-a,y+b,z+c]].map(transform);[[0,1,2,3],[1,5,6,2],[5,4,7,6],[4,0,3,7],[3,2,6,7]].forEach((face,index)=>poly(face.map(i=>v[i]),index===4?top:side));};
  const disk=(center,r,fill,stroke,transform=point=>point)=>{const q=[];for(let i=0;i<40;i++){const a=i*Math.PI*2/40;q.push(transform([center[0]+Math.cos(a)*r,center[1],center[2]+Math.sin(a)*r]));}poly(q,fill,stroke);};
  const az=point=>rotateAzimuth(point,state.h),panel=point=>panelWorldPoint(point,state.h,state.v);
  const ringGear=(center,r,phase=0,transform=point=>point)=>{const edge=[];for(let i=0;i<32;i++){const a=i*Math.PI*2/32;edge.push(transform([center[0],center[1]+Math.cos(a)*r,center[2]+Math.sin(a)*r]));}poly(edge,'#151b1d','#d7e3e2');for(let i=0;i<32;i++){const a=i*Math.PI*2/32+phase;line(transform([center[0]-3,center[1]+Math.cos(a)*(r-5),center[2]+Math.sin(a)*(r-5)]),transform([center[0]-3,center[1]+Math.cos(a)*(r+5),center[2]+Math.sin(a)*(r+5)]),'#d7e3e2',1);}};
  const wormAlongX=(left,right,y,z,phase=0,transform=point=>point)=>{line(transform([left,y,z]),transform([right,y,z]),'#141a1c',8);for(let i=0;i<14;i++){const x=left+(right-left)*i/13,a=i*.9+phase;line(transform([x,y+Math.cos(a)*6,z+Math.sin(a)*6]),transform([x,y-Math.cos(a)*6,z-Math.sin(a)*6]),'#c6d2d1',1.5);}};
  const lcdFace=(corners,title,lines)=>{poly(corners,'#d7d9d2','#f7ffff');const inner=corners.map((p,i)=>{const next=corners[(i+1)%4],prev=corners[(i+3)%4];return [p[0]*.91+next[0]*.045+prev[0]*.045,p[1]*.91+next[1]*.045+prev[1]*.045,p[2]*.91+next[2]*.045+prev[2]*.045];});poly(inner,'#263c29','#0b120c');const at=inner.reduce((total,point)=>total.map((value,index)=>value+point[index]/4),[0,0,0]),p=project(at);ctx.fillStyle='#d7f28b';ctx.font='7px ui-monospace';ctx.textAlign='center';ctx.fillText(title,p.x,p.y-7);ctx.fillText((lines[0]||'').trim().slice(0,14),p.x,p.y+1);ctx.fillText((lines[1]||'').trim().slice(0,14),p.x,p.y+9);ctx.textAlign='start';};
  const caption=(text,point,color='#c9e7e4')=>{const p=project(point);ctx.fillStyle=color;ctx.font='bold 10px ui-monospace';ctx.fillText(text,p.x+5,p.y-4);};
  const sensorBadge=(text,point)=>{const p=project(point),label=text,boxW=ctx.measureText(label).width+8;ctx.fillStyle='rgba(4,20,25,.86)';ctx.fillRect(p.x-boxW/2,p.y-17,boxW,13);ctx.strokeStyle='#dffc85';ctx.lineWidth=1;ctx.strokeRect(p.x-boxW/2,p.y-17,boxW,13);ctx.fillStyle='#ecff9d';ctx.font='bold 9px ui-monospace';ctx.textAlign='center';ctx.fillText(label,p.x,p.y-7);ctx.textAlign='start';};

  // 1) Fixed lower acrylic box.  The horizontal motor is inside this box and
  // points upward; only its shaft, bearing and all structure above it rotate.
  for(let z=-330;z<=330;z+=55)line([-330,0,z],[330,0,z],'#123942',.55);for(let x=-330;x<=330;x+=55)line([x,0,-330],[x,0,330],'#123942',.55);
  box([0,-28,0],[232,10,232],'#111517','#030607');
  box([0,-18,0],[220,8,220],'#9aa8a9','#2d3b3e');
  box([0,-10,0],[210,8,210],'#080b0d','#111a1d');
  // Clear lower walls and top cover.
  const cube=[[-105,-6,-105],[105,-6,-105],[105,-6,105],[-105,-6,105],[-105,108,-105],[105,108,-105],[105,108,105],[-105,108,105]];
  poly([cube[0],cube[1],cube[5],cube[4]],'rgba(190,222,225,.18)','#b4d0d2');poly([cube[1],cube[2],cube[6],cube[5]],'rgba(190,222,225,.12)','#b4d0d2');poly([cube[3],cube[0],cube[4],cube[7]],'rgba(190,222,225,.13)','#b4d0d2');
  line(cube[4],cube[5],'#e6ffff',2);line(cube[5],cube[6],'#e6ffff',2);line(cube[6],cube[7],'#e6ffff',2);line(cube[7],cube[4],'#e6ffff',2);
  box([0,108,0],[216,5,216],'rgba(225,250,250,.28)','rgba(155,200,204,.18)');
  // Upward facing azimuth motor, fixed to the lower box, with its output shaft.
  box([0,39,0],[54,56,54],'#151a1c','#05090a');disk([0,68,0],23,'#242f31','#b8c8c8');
  line([0,67,0],[0,114,0],'#d4e2df',7);caption('D9 · 수평 모터',[-32,50,-24],'#f5db7a');
  // Actual LCD modules on two lower-box faces; their glyphs are read from the
  // independent I²C LCD buffers, not hard-coded canvas text.
  const l1=lcdText('26'),l2=lcdText('27');
  lcdFace([[-90,66,-108],[-12,66,-108],[-12,33,-108],[-90,33,-108]],'LCD1 0x26',l1);
  lcdFace([[108,66,-82],[108,66,-8],[108,33,-8],[108,33,-82]],'LCD2 0x27',l2);

  // 2) D9 output: bearing, round rotating plate and the complete upper box.
  disk([0,113,0],78,'#c6d1d1','#f4ffff');disk([0,117,0],69,'#1c2427','#9db5b6',az);disk([0,121,0],60,'#d9e4e2','#f5ffff',az);
  box([0,125,0],[168,8,168],'rgba(225,250,250,.28)','rgba(155,200,204,.2)',az);
  // Rotating transparent upper enclosure and aluminium corner profiles.
  [[-72,-58],[72,-58],[-72,58],[72,58]].forEach(([x,z])=>box([x,164,z],[10,82,10],'#e8f0ee','#8ea2a2',az));
  [[-76,58],[76,58]].forEach(([x,z])=>line(az([x,123,z]),az([x,205,z]),'#f3ffff',1.5));
  box([0,205,0],[168,8,168],'rgba(218,242,242,.22)','rgba(141,187,188,.34)',az);
  // 3) Side-facing elevation motor.  Its shaft and worm share a single X axis;
  // the worm engages the Y–Z-plane wheel which transfers torque to the hinge.
  box([83,183,-40],[46,46,56],'#151b1d','#05090a',az);
  disk(az([58,183,-40]),20,'#334043','#d2e0df');
  wormAlongX(10,60,183,-40,(state.v-90)*Math.PI/18,az);
  ringGear([0,183,-40],31,(state.v-90)*Math.PI/18,az);
  line(az([0,183,-40]),az([0,243,-18]),'#d0dddd',7);
  box([0,238,-18],[76,18,48],'#dae4e1','#788d8e',az);
  disk(az([0,258,-14]),22,'#222b2d','#c2d2d0');
  caption('D10 · 측면 모터 → 웜',az([55,207,-62]),'#f5db7a');
  caption('웜기어 · 수직 힌지',az([-43,197,-51]),'#f5db7a');
  // Rigid supports stay with D9; the panel alone pivots about the X hinge via D10.
  [-58,58].forEach(x=>{line(az([x,205,0]),az([x,258,0]),'#dce8e5',7);line(az([x,205,0]),az([x,258,-35]),'#799192',3);});
  line(az([-84,260,0]),az([84,260,0]),'#eff9f7',8);
  // 4) Solar module: all vertices use panelWorldPoint(), so D9 turns left/right
  // and D10 raises/lowers it directly from Arduino-controlled angles.
  const halfW=m.width*worldPerMm/2,halfH=m.height*worldPerMm/2;
  const panelQuad=(x0,y0,x1,y1,z,fill,stroke)=>poly([[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]].map(panel),fill,stroke);
  panelQuad(-halfW-12,-halfH-12,halfW+12,halfH+12,-6,'#f2f4f1','#798887');
  panelQuad(-halfW-5,-halfH-5,halfW+5,halfH+5,1,'#0a0c0d','#e4ecea');
  const cols=7,rows=5,cellW=(halfW*2-16)/cols,cellH=(halfH*2-16)/rows;
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){const x0=-halfW+8+col*cellW,y0=-halfH+8+row*cellH;panelQuad(x0,y0,x0+cellW-2,y0+cellH-2,3,(row+col)%2?'#030507':'#07090b','#c6cfce');}
  // Divider-shielded A0–A3 CdS sensor head on the panel face.
  panelQuad(-36,-36,36,36,8,'#10191a','#77dcd4');line(panel([0,-38,10]),panel([0,38,10]),'#79ece1',2);line(panel([-38,0,10]),panel([38,0,10]),'#79ece1',2);
  // Actual wiring order on the divider-shielded sensor head: viewed from the
  // panel front, CDS3/A2 and CDS1/A0 are on top; CDS4/A3 and CDS2/A1 below.
  [[-19,-19,'CDS3 · A2'],[19,-19,'CDS1 · A0'],[-19,19,'CDS4 · A3'],[19,19,'CDS2 · A1']].forEach(([x,y,label])=>{const c=panel([x,y,11]),p=project(c);ctx.fillStyle='#dcf47a';ctx.beginPath();ctx.arc(p.x,p.y,5*p.s,0,Math.PI*2);ctx.fill();sensorBadge(label,panel([x,y,13]));});
  // The yellow sphere is the configured light location in the same 3D frame as
  // the panel.  Its dashed ray ends at the LDR head, so azimuth/elevation are
  // directly inspectable rather than being only control values.
  const lightOrigin=panel([0,0,14]),lightPoint=[state.lightDirection[0]*250,panelMountHeight+state.lightDirection[1]*250,state.lightDirection[2]*250];
  const origin2d=project(lightOrigin),rawSun=project(lightPoint),sun={x:clamp(rawSun.x,34,w-34),y:clamp(rawSun.y,34,h-34),clipped:rawSun.x<34||rawSun.x>w-34||rawSun.y<34||rawSun.y>h-34};ctx.strokeStyle='rgba(255,221,95,.88)';ctx.lineWidth=1.6;ctx.setLineDash([7,5]);ctx.beginPath();ctx.moveTo(origin2d.x,origin2d.y);ctx.lineTo(sun.x,sun.y);ctx.stroke();ctx.setLineDash([]);const glow=ctx.createRadialGradient(sun.x,sun.y,2,sun.x,sun.y,24);glow.addColorStop(0,'rgba(255,248,177,1)');glow.addColorStop(.32,'rgba(255,202,54,.95)');glow.addColorStop(1,'rgba(255,194,40,0)');ctx.fillStyle=glow;ctx.beginPath();ctx.arc(sun.x,sun.y,24,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff3a4';ctx.beginPath();ctx.arc(sun.x,sun.y,7,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff1a0';ctx.font='bold 10px ui-monospace';ctx.fillText(`${sun.clipped?'↗ ':''}SUN Az ${e.az}° · El ${e.el}°`,sun.x+10,sun.y-10);ctx.fillStyle='rgba(4,23,30,.9)';ctx.fillRect(14,66,166,43);ctx.strokeStyle='#d9b94c';ctx.strokeRect(14,66,166,43);ctx.fillStyle='#ffe777';ctx.beginPath();ctx.arc(31,83,8,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff3a4';ctx.font='bold 10px ui-monospace';ctx.fillText('설정 태양 위치',46,81);ctx.font='9px ui-monospace';ctx.fillText(`Az ${e.az}° · El ${e.el}°`,46,97);ctx.fillStyle='#cfe8e4';ctx.fillText('노란 점선 = 입사 광선',14,123);
  // Physical normal used by the dot-product power model.
  const center=panel([0,0,12]),normal=panel([0,0,96]);line(center,normal,'#58f2e6',3);const n=project(normal);ctx.fillStyle='#7ffff2';ctx.font='bold 12px ui-monospace';ctx.fillText('N',n.x+5,n.y-4);
  ctx.fillStyle='#b9d6d4';ctx.font='11px ui-monospace';ctx.fillText(`D9 수평 ${displayH}° → 회전 베어링 · D10 수직 ${displayV}° → 웜기어 · 입사각 ${state.incidenceAngle.toFixed(2)}°`,14,25);ctx.font='10px ui-monospace';ctx.fillText('하부 모터 → 회전판 → 상부 박스 / 측면 모터 → 웜 → 웜기어 → 태양광 패널',14,43);
}

function setup3dControls(){const c=$('rigCanvas');c.addEventListener('pointerdown',event=>{viewer.drag={x:event.clientX,y:event.clientY};c.setPointerCapture?.(event.pointerId);});c.addEventListener('pointermove',event=>{if(!viewer.drag)return;viewer.yaw+=(event.clientX-viewer.drag.x)*.012;viewer.pitch=clamp(viewer.pitch+(event.clientY-viewer.drag.y)*.009,-1.2,.45);viewer.drag={x:event.clientX,y:event.clientY};});['pointerup','pointercancel','pointerleave'].forEach(type=>c.addEventListener(type,()=>{viewer.drag=null;}));c.addEventListener('wheel',event=>{event.preventDefault();viewer.zoom=clamp(viewer.zoom-event.deltaY*.001,.62,1.85);},{passive:false});$('viewReset').addEventListener('click',()=>{Object.assign(viewer,defaultViewerPose);renderAll();});}
function renderAll(){syncGraduationSketchTelemetry();const p=state.pins,l=state.ldr;$('a0').textContent=String(p.A0).padStart(4,'0');$('a1').textContent=String(p.A1).padStart(4,'0');$('a2').textContent=String(p.A2).padStart(4,'0');$('a3').textContent=String(p.A3).padStart(4,'0');$('leftAvg').textContent=l.left.toFixed(1);$('rightAvg').textContent=l.right.toFixed(1);$('topAvg').textContent=l.top.toFixed(1);$('bottomAvg').textContent=l.bottom.toFixed(1);$('hError').textContent=(l.right-l.left).toFixed(1);$('vError').textContent=(l.top-l.bottom).toFixed(1);$('hAngle').textContent=`${state.h}°`;$('vAngle').textContent=`${state.v}°`;$('power').textContent=`${state.power.toFixed(2)} W`;$('incidence').textContent=`${state.incidenceAngle.toFixed(1)}°`;$('alignment').textContent=`${(state.alignment*100).toFixed(1)}%`;$('voltage').textContent=`${state.voltage.toFixed(2)} V`;$('current').textContent=`${state.current.toFixed(3)} A`;$('energy').textContent=`${state.energy.toFixed(3)} Wh`;$('co2').textContent=state.co2Kg<.001?`${(state.co2Kg*1000).toFixed(2)} g`:`${state.co2Kg.toFixed(4)} kg`;$('systemState').textContent=state.systemState;$('beforePower').textContent=state.beforePower===null?'—':`${state.beforePower.toFixed(2)} W`;$('afterPower').textContent=state.afterPower===null?'—':`${state.afterPower.toFixed(2)} W`;$('improvement').textContent=state.increaseRate===null?'—':`${state.increaseRate.toFixed(1)}%`;$('lcd26').innerHTML=lcdText('26').map(x=>`<span>${esc(x)}</span>`).join('');$('lcd27').innerHTML=lcdText('27').map(x=>`<span>${esc(x)}</span>`).join('');$('runChip').textContent=state.running?state.systemState:'STOPPED';$('runChip').classList.toggle('running',state.running);$('runBtn').textContent=state.running?'Ⅱ 일시정지':'▶ 실행';updateTorqueSimulation();updateDesignVerification();drawRig();}
function formatTrackerAngles(){
  $('hAngle').textContent=`${state.h.toFixed(2)}°`;
  $('vAngle').textContent=`${state.v.toFixed(2)}°`;
}
function tick(t){if(state.lastFrame===null)state.lastFrame=t;let d=Math.min(.2,(t-state.lastFrame)/1000);state.lastFrame=t;updateEnvironment();if(state.running){d*=env().speed;state.elapsed+=d;if(!state.advancedController){state.energy+=state.power*d/3600;state.co2Kg=state.energy/1000*env().co2Factor;}if(state.elapsed>=state.nextLoop){runLoop();state.nextLoop=state.elapsed+state.loopDelay;}}updateInaTelemetry();updatePagedLcdProfile();renderAll();formatTrackerAngles();requestAnimationFrame(tick);}
function wire(){$('codeEditor').value=half4WireDefaultSketch;const count=()=>{const source=$('codeEditor').value;$('codeLines').textContent=`${source.split('\n').length} lines`;renderUnoCompatibility(source);};$('codeEditor').addEventListener('input',count);count();[['lightAz','lightAzOut','°'],['lightEl','lightElOut','°']].forEach(([i,o,u])=>{const f=()=>$(o).value=$(i).value+u;$(i).addEventListener('input',f);f();});$('compileBtn').addEventListener('click',compileSketch);$('runBtn').addEventListener('click',()=>{if(!state.compiled&&!compileSketch())return;if(state.auto?.phase==='FINAL'){restartAutoTracking();}else{state.running=!state.running;serialPrint(state.running?'Simulation running':'Simulation paused');}renderAll();});$('stepBtn').addEventListener('click',()=>{if(!state.compiled&&!compileSketch())return;runLoop();renderAll();});$('resetBtn').addEventListener('click',resetBoard);$('exampleBtn').addEventListener('click',()=>{$('codeEditor').value=half4WireDefaultSketch;count();setMessage('기본 예제를 편집기에 복원했습니다.');});$('verifyBtn').addEventListener('click',runDesignVerification);$('clearLog').addEventListener('click',()=>{state.serial=[];renderSerial();});}
function wireV2(){wire();['panelWidth','panelHeight'].forEach(id=>{const update=()=>{updateTorqueSimulation();renderAll();};$(id).addEventListener('input',update);$(id).addEventListener('change',update);});}
wireV2();setup3dControls();updateEnvironment();renderAll();serialPrint('Virtual Uno ready — click Compile · Apply');requestAnimationFrame(tick);
loadSuppliedCadMeshes();
