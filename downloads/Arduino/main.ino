String inputString = "";
bool stringComplete = false;
bool ledState = false; // состояние светодиода (false = выключен, true = включен)

void setup() {
  Serial.begin(115200);
  pinMode(13, OUTPUT);
  digitalWrite(13, ledState); // начальное состояние
  inputString.reserve(20);
}

void loop() {
  if (stringComplete) {
    inputString.trim(); // удаляем лишние пробелы и символы перевода строки

    if (inputString == "MENU") {
      ledState = !ledState; // переключаем состояние
      digitalWrite(13, ledState ? HIGH : LOW); // включаем/выключаем светодиод
    }

    // очищаем строку
    inputString = "";
    stringComplete = false;
  }
}

void serialEvent() {
  while (Serial.available()) {
    char inChar = (char)Serial.read();
    inputString += inChar;
    if (inChar == '\n') {
      stringComplete = true;
    }
  }
}