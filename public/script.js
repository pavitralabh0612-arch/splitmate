(function () {
  "use strict";

  /* ==========================================================================
     1. Constants & Documented Application Limits
     ========================================================================== */

  /**
   * Storage key and schema version for persisted calculations.
   */
  var STORAGE_KEY = "splitmate_saved_result_v2";
  var LEGACY_STORAGE_KEY = "splitmate_saved_result_v1";
  var STORAGE_SCHEMA_VERSION = 2;

  /**
   * Documented Operational Limits:
   * - MIN_BILL_PAISE: 1 paisa (₹0.01) — smallest positive Indian currency unit.
   * - MAX_BILL_PAISE: 1,000,000,000 paise (₹1,00,00,000.00 / ₹1 Crore) — well within
   *   Number.MAX_SAFE_INTEGER, preventing any integer overflow.
   * - MIN_PEOPLE: 1 person.
   * - MAX_PEOPLE: 100 people — prevents excessive DOM node creation while accommodating
   *   large banquets, student groups, and hostel dinners.
   * - MAX_OCCASION_LENGTH: 80 characters.
   * - MAX_PERSON_NAME_LENGTH: 50 characters.
   */
  var MIN_BILL_PAISE = 1;
  var MAX_BILL_PAISE = 1000000000; // ₹1,00,00,000.00
  var MIN_PEOPLE = 1;
  var MAX_PEOPLE = 100;
  var MAX_OCCASION_LENGTH = 80;
  var MAX_PERSON_NAME_LENGTH = 50;

  /**
   * Single source of truth for the latest valid calculation currently active in the UI,
   * and an in-memory draft array of participant names so typing/changing group size
   * preserves entered names.
   */
  var currentCalculation = null;
  var draftPersonNames = [];

  /* ==========================================================================
     2. Exact Currency Formatting & Integer Paise Parsing
     ========================================================================== */

  /**
   * Formats an exact integer number of paise into an Indian Rupee string
   * with standard Indian digit grouping (lakhs/crores) and exactly 2 decimal places.
   *
   * @param {number} paise - Non-negative safe integer representing paise.
   * @returns {string} Formatted INR currency string.
   */
  function formatPaiseToINR(paise) {
    if (
      typeof paise !== "number" ||
      !Number.isSafeInteger(paise) ||
      paise < 0
    ) {
      return "₹0.00";
    }

    var wholeRupees = Math.floor(paise / 100);
    var remainderPaise = paise % 100;

    var rupeesStr = String(wholeRupees);
    var formattedRupees = formatIndianDigits(rupeesStr);
    var formattedPaise =
      remainderPaise < 10 ? "0" + String(remainderPaise) : String(remainderPaise);

    return "₹" + formattedRupees + "." + formattedPaise;
  }

  /**
   * Formats a string of digits using the Indian numbering system (last 3 digits,
   * then groups of 2 digits: e.g., "10000000" -> "1,00,00,000").
   *
   * @param {string} digitStr
   * @returns {string}
   */
  function formatIndianDigits(digitStr) {
    if (digitStr.length <= 3) {
      return digitStr;
    }
    var lastThree = digitStr.slice(-3);
    var remaining = digitStr.slice(0, -3);
    return (
      remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + lastThree
    );
  }

  /**
   * Converts a raw rupee input string (or number) into an exact integer number of paise
   * without using floating-point multiplication.
   *
   * @param {string|number} rawInput
   * @returns {{ ok: boolean, paise?: number, error?: string }}
   */
  function parseAmountToPaise(rawInput) {
    if (rawInput === null || rawInput === undefined) {
      return {
        ok: false,
        error: "Enter the total bill amount in Indian Rupees."
      };
    }

    if (typeof rawInput === "number") {
      if (!Number.isFinite(rawInput)) {
        return {
          ok: false,
          error: "Enter a valid numeric bill amount in Indian Rupees."
        };
      }
      rawInput = String(rawInput);
    }

    if (typeof rawInput !== "string") {
      return {
        ok: false,
        error: "Enter a valid numeric bill amount in Indian Rupees."
      };
    }

    var trimmed = rawInput.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        error: "Enter the total bill amount in Indian Rupees."
      };
    }

    if (trimmed.charAt(0) === "-") {
      return {
        ok: false,
        error:
          "Total bill amount must be greater than ₹0.00 (negative amounts are not allowed)."
      };
    }

    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return {
        ok: false,
        error:
          "Enter a valid rupee amount using digits and an optional decimal point (for example, 1850.50)."
      };
    }

    var parts = trimmed.split(".");
    var rawRupeesPart = parts[0];
    var rawFractionPart = parts.length > 1 ? parts[1] : "";

    if (rawFractionPart.length > 2) {
      return {
        ok: false,
        error:
          "Bill amount cannot have more than 2 decimal places (paise). Please enter an exact amount up to 2 decimals."
      };
    }

    var normalizedRupeesStr = rawRupeesPart.replace(/^0+(?=\d)/, "");

    if (normalizedRupeesStr.length > 10) {
      return {
        ok: false,
        error:
          "Total bill amount cannot exceed " +
          formatPaiseToINR(MAX_BILL_PAISE) +
          "."
      };
    }

    var paddedFractionStr = (rawFractionPart + "00").slice(0, 2);
    var rupeesInt = parseInt(normalizedRupeesStr, 10);
    var paiseInt = parseInt(paddedFractionStr, 10);

    if (
      !Number.isSafeInteger(rupeesInt) ||
      !Number.isSafeInteger(paiseInt)
    ) {
      return {
        ok: false,
        error: "Bill amount is outside the safe calculation range."
      };
    }

    var totalPaise = rupeesInt * 100 + paiseInt;

    if (!Number.isSafeInteger(totalPaise)) {
      return {
        ok: false,
        error: "Bill amount is outside the safe calculation range."
      };
    }

    if (totalPaise < MIN_BILL_PAISE) {
      return {
        ok: false,
        error: "Total bill amount must be at least ₹0.01."
      };
    }

    if (totalPaise > MAX_BILL_PAISE) {
      return {
        ok: false,
        error:
          "Total bill amount cannot exceed " +
          formatPaiseToINR(MAX_BILL_PAISE) +
          "."
      };
    }

    return {
      ok: true,
      paise: totalPaise
    };
  }

  /**
   * Normalizes an array of raw participant names for a given peopleCount.
   * Trims whitespace, enforces MAX_PERSON_NAME_LENGTH, and falls back to
   * "Person 1", "Person 2", etc. whenever an entry is left blank.
   *
   * @param {Array<string>} rawNames
   * @param {number} peopleCount
   * @returns {Array<string>}
   */
  function normalizePersonNames(rawNames, peopleCount) {
    var normalized = [];
    for (var i = 0; i < peopleCount; i++) {
      var candidate =
        Array.isArray(rawNames) && typeof rawNames[i] === "string"
          ? rawNames[i].trim()
          : "";
      if (candidate.length > MAX_PERSON_NAME_LENGTH) {
        candidate = candidate.slice(0, MAX_PERSON_NAME_LENGTH).trim();
      }
      normalized.push(candidate.length > 0 ? candidate : "Person " + String(i + 1));
    }
    return normalized;
  }

  /* ==========================================================================
     3. Input Validation
     ========================================================================== */

  /**
   * Validates occasion name, bill amount, number of people, and participant names.
   *
   * @param {string} rawOccasion
   * @param {string} rawAmount
   * @param {string} rawPeople
   * @param {Array<string>} rawPersonNames
   */
  function validateInputs(rawOccasion, rawAmount, rawPeople, rawPersonNames) {
    var fieldErrors = {};
    var errorOrder = [];

    // 1. Validate Bill Amount
    var amountResult = parseAmountToPaise(rawAmount);
    if (!amountResult.ok) {
      fieldErrors.billAmount = amountResult.error;
      errorOrder.push("billAmount");
    }

    // 2. Validate Occasion Name
    var trimmedOccasion =
      typeof rawOccasion === "string" ? rawOccasion.trim() : "";
    if (trimmedOccasion.length === 0) {
      fieldErrors.occasionName =
        "Enter an occasion name (for example, Dinner at Olive Garden).";
      errorOrder.push("occasionName");
    } else if (trimmedOccasion.length > MAX_OCCASION_LENGTH) {
      fieldErrors.occasionName =
        "Occasion name must be " +
        MAX_OCCASION_LENGTH +
        " characters or fewer.";
      errorOrder.push("occasionName");
    }

    // 3. Validate People Count
    var trimmedPeople =
      typeof rawPeople === "string"
        ? rawPeople.trim()
        : rawPeople !== null && rawPeople !== undefined
          ? String(rawPeople).trim()
          : "";

    var peopleCount = 0;
    if (trimmedPeople.length === 0) {
      fieldErrors.peopleCount =
        "Enter the number of people sharing the bill.";
      errorOrder.push("peopleCount");
    } else if (trimmedPeople.charAt(0) === "-") {
      fieldErrors.peopleCount =
        "Number of people must be at least " +
        MIN_PEOPLE +
        " (negative numbers are not allowed).";
      errorOrder.push("peopleCount");
    } else if (trimmedPeople.indexOf(".") !== -1) {
      fieldErrors.peopleCount =
        "Number of people must be a whole integer without decimals.";
      errorOrder.push("peopleCount");
    } else if (!/^\d+$/.test(trimmedPeople)) {
      fieldErrors.peopleCount =
        "Enter a valid whole number of people (digits only).";
      errorOrder.push("peopleCount");
    } else {
      var normalizedPeopleStr = trimmedPeople.replace(/^0+(?=\d)/, "");
      if (normalizedPeopleStr.length > 5) {
        fieldErrors.peopleCount =
          "Number of people cannot exceed " + MAX_PEOPLE + ".";
        errorOrder.push("peopleCount");
      } else {
        peopleCount = parseInt(normalizedPeopleStr, 10);
        if (!Number.isSafeInteger(peopleCount) || peopleCount < MIN_PEOPLE) {
          fieldErrors.peopleCount =
            "Number of people must be at least " + MIN_PEOPLE + ".";
          errorOrder.push("peopleCount");
        } else if (peopleCount > MAX_PEOPLE) {
          fieldErrors.peopleCount =
            "Number of people cannot exceed " +
            MAX_PEOPLE +
            " so the breakdown remains clear and responsive.";
          errorOrder.push("peopleCount");
        }
      }
    }

    if (errorOrder.length > 0) {
      return {
        valid: false,
        fieldErrors: fieldErrors,
        errorOrder: errorOrder
      };
    }

    var personNames = normalizePersonNames(rawPersonNames, peopleCount);

    return {
      valid: true,
      data: {
        occasion: trimmedOccasion,
        totalPaise: amountResult.paise,
        peopleCount: peopleCount,
        personNames: personNames
      },
      fieldErrors: {},
      errorOrder: []
    };
  }

  /* ==========================================================================
     4. Exact Integer Paise Distribution
     ========================================================================== */

  /**
   * Divides an exact integer paise total across `peopleCount` people using pure
   * integer arithmetic.
   *
   * @param {number} totalPaise - Positive safe integer in paise.
   * @param {number} peopleCount - Positive safe integer count of people.
   */
  function splitBillExactly(totalPaise, peopleCount) {
    if (
      !Number.isSafeInteger(totalPaise) ||
      totalPaise < MIN_BILL_PAISE ||
      totalPaise > MAX_BILL_PAISE
    ) {
      throw new Error("Invalid totalPaise supplied to splitBillExactly.");
    }

    if (
      !Number.isSafeInteger(peopleCount) ||
      peopleCount < MIN_PEOPLE ||
      peopleCount > MAX_PEOPLE
    ) {
      throw new Error("Invalid peopleCount supplied to splitBillExactly.");
    }

    var baseSharePaise = Math.floor(totalPaise / peopleCount);
    var remainderPaise = totalPaise % peopleCount;

    var sharesPaise = [];
    var allocatedSumPaise = 0;

    for (var i = 0; i < peopleCount; i++) {
      var extraPaisa = i < remainderPaise ? 1 : 0;
      var personShare = baseSharePaise + extraPaisa;

      if (!Number.isSafeInteger(personShare) || personShare < 0) {
        throw new Error("Calculated share is not a valid non-negative integer.");
      }

      sharesPaise.push(personShare);
      allocatedSumPaise += personShare;
    }

    if (
      sharesPaise.length !== peopleCount ||
      allocatedSumPaise !== totalPaise
    ) {
      throw new Error(
        "Reconciliation check failed: allocated shares do not match total bill."
      );
    }

    return {
      totalPaise: totalPaise,
      peopleCount: peopleCount,
      baseSharePaise: baseSharePaise,
      remainderPaise: remainderPaise,
      sharesPaise: sharesPaise,
      allocatedSumPaise: allocatedSumPaise
    };
  }

  /* ==========================================================================
     5. LocalStorage Persistence & Strict Restoration Validation
     ========================================================================== */

  /**
   * Saves a verified calculation object (including participant names) to localStorage.
   */
  function saveResult(calculation) {
    try {
      if (!window.localStorage) {
        return false;
      }

      var payload = {
        version: STORAGE_SCHEMA_VERSION,
        occasion: calculation.occasion,
        totalPaise: calculation.totalPaise,
        peopleCount: calculation.peopleCount,
        personNames: calculation.personNames.slice(),
        sharesPaise: calculation.sharesPaise.slice()
      };

      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Reads, validates, and reconstructs a saved calculation from localStorage.
   */
  function restoreResult() {
    var rawJson = null;
    try {
      if (!window.localStorage) {
        return null;
      }
      rawJson =
        window.localStorage.getItem(STORAGE_KEY) ||
        window.localStorage.getItem(LEGACY_STORAGE_KEY);
    } catch (err) {
      return null;
    }

    if (!rawJson || typeof rawJson !== "string") {
      return null;
    }

    try {
      var parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        removeCorruptedStorageSafely();
        return null;
      }

      if (parsed.version !== STORAGE_SCHEMA_VERSION && parsed.version !== 1) {
        removeCorruptedStorageSafely();
        return null;
      }

      if (typeof parsed.occasion !== "string") {
        removeCorruptedStorageSafely();
        return null;
      }
      var trimmedOccasion = parsed.occasion.trim();
      if (
        trimmedOccasion.length === 0 ||
        trimmedOccasion.length > MAX_OCCASION_LENGTH
      ) {
        removeCorruptedStorageSafely();
        return null;
      }

      if (
        typeof parsed.totalPaise !== "number" ||
        !Number.isSafeInteger(parsed.totalPaise) ||
        parsed.totalPaise < MIN_BILL_PAISE ||
        parsed.totalPaise > MAX_BILL_PAISE
      ) {
        removeCorruptedStorageSafely();
        return null;
      }

      if (
        typeof parsed.peopleCount !== "number" ||
        !Number.isSafeInteger(parsed.peopleCount) ||
        parsed.peopleCount < MIN_PEOPLE ||
        parsed.peopleCount > MAX_PEOPLE
      ) {
        removeCorruptedStorageSafely();
        return null;
      }

      if (
        !Array.isArray(parsed.sharesPaise) ||
        parsed.sharesPaise.length !== parsed.peopleCount
      ) {
        removeCorruptedStorageSafely();
        return null;
      }

      var expectedSplit = splitBillExactly(
        parsed.totalPaise,
        parsed.peopleCount
      );

      var storedSum = 0;
      for (var i = 0; i < parsed.sharesPaise.length; i++) {
        var share = parsed.sharesPaise[i];
        if (
          typeof share !== "number" ||
          !Number.isSafeInteger(share) ||
          share < 0 ||
          share !== expectedSplit.sharesPaise[i]
        ) {
          removeCorruptedStorageSafely();
          return null;
        }
        storedSum += share;
      }

      if (storedSum !== parsed.totalPaise) {
        removeCorruptedStorageSafely();
        return null;
      }

      var personNames = normalizePersonNames(
        parsed.personNames,
        expectedSplit.peopleCount
      );

      return {
        occasion: trimmedOccasion,
        totalPaise: expectedSplit.totalPaise,
        peopleCount: expectedSplit.peopleCount,
        personNames: personNames,
        baseSharePaise: expectedSplit.baseSharePaise,
        remainderPaise: expectedSplit.remainderPaise,
        sharesPaise: expectedSplit.sharesPaise,
        allocatedSumPaise: expectedSplit.allocatedSumPaise
      };
    } catch (err) {
      removeCorruptedStorageSafely();
      return null;
    }
  }

  function removeCorruptedStorageSafely() {
    try {
      if (window.localStorage) {
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch (err) {
      // Ignore storage access errors in restricted contexts
    }
  }

  /* ==========================================================================
     6. Dynamic Pizza Diagram, Participant Name Inputs & DOM Rendering
     ========================================================================== */

  /**
   * Updates the rotating pizza SVG cutter lines and caption to match the
   * current group size (defaults to 8 slices when empty/unspecified).
   *
   * @param {object} dom
   * @param {number|null} peopleCount
   */
  function updatePizzaDiagram(dom, peopleCount) {
    if (!dom.pizzaSliceLines || !dom.pizzaSliceCaption) {
      return;
    }

    var activeCount =
      typeof peopleCount === "number" &&
      Number.isSafeInteger(peopleCount) &&
      peopleCount >= MIN_PEOPLE &&
      peopleCount <= MAX_PEOPLE
        ? peopleCount
        : 8;

    // Cap visual SVG cut lines at 16 so the pizza remains crisp and readable
    var visualSlices = activeCount > 16 ? 16 : activeCount;

    while (dom.pizzaSliceLines.firstChild) {
      dom.pizzaSliceLines.removeChild(dom.pizzaSliceLines.firstChild);
    }

    var svgNS = "http://www.w3.org/2000/svg";
    var centerX = 120;
    var centerY = 120;
    var radius = 98;

    if (visualSlices > 1) {
      for (var i = 0; i < visualSlices; i++) {
        var angleRad = (i * 2 * Math.PI) / visualSlices - Math.PI / 2;
        var x2 = centerX + radius * Math.cos(angleRad);
        var y2 = centerY + radius * Math.sin(angleRad);

        var line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", String(centerX));
        line.setAttribute("y1", String(centerY));
        line.setAttribute("x2", x2.toFixed(2));
        line.setAttribute("y2", y2.toFixed(2));
        dom.pizzaSliceLines.appendChild(line);
      }
    }

    if (
      typeof peopleCount === "number" &&
      Number.isSafeInteger(peopleCount) &&
      peopleCount >= MIN_PEOPLE &&
      peopleCount <= MAX_PEOPLE
    ) {
      dom.pizzaSliceCaption.textContent =
        peopleCount === 1
          ? "1 Whole Pizza · 100% Yours"
          : String(peopleCount) + " Fair Slices · Zero Awkward Math";
    } else {
      dom.pizzaSliceCaption.textContent = "8 Equal Slices · 100% Fair Share";
    }
  }

  /**
   * Reads the currently rendered participant name input fields into `draftPersonNames`
   * and returns the array of raw strings.
   *
   * @param {object} dom
   * @returns {Array<string>}
   */
  function collectEnteredPersonNames(dom) {
    if (!dom.peopleNamesGrid) {
      return draftPersonNames.slice();
    }
    var inputs = dom.peopleNamesGrid.querySelectorAll("input.person-name-input");
    for (var i = 0; i < inputs.length; i++) {
      draftPersonNames[i] = inputs[i].value;
    }
    return draftPersonNames.slice();
  }

  /**
   * Synchronizes the dynamic participant name fields in Page 1 whenever the
   * user changes the "Number of people" input.
   *
   * @param {object} dom
   * @param {number|null} count
   */
  function renderPersonNameInputs(dom, count) {
    updatePizzaDiagram(dom, count);

    if (!dom.peopleNamesGrid || !dom.peopleNamesPlaceholder) {
      return;
    }

    // Save any names typed so far before re-rendering
    collectEnteredPersonNames(dom);

    while (dom.peopleNamesGrid.firstChild) {
      dom.peopleNamesGrid.removeChild(dom.peopleNamesGrid.firstChild);
    }

    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < MIN_PEOPLE ||
      count > MAX_PEOPLE
    ) {
      dom.peopleNamesGrid.hidden = true;
      dom.peopleNamesPlaceholder.hidden = false;
      if (dom.clearNamesBtn) {
        dom.clearNamesBtn.hidden = true;
      }
      return;
    }

    dom.peopleNamesPlaceholder.hidden = true;
    dom.peopleNamesGrid.hidden = false;
    if (dom.clearNamesBtn) {
      dom.clearNamesBtn.hidden = false;
    }

    var fragment = document.createDocumentFragment();
    var samplePlaceholders = [
      "Aarav",
      "Priya",
      "Rohan",
      "Sneha",
      "Kabir",
      "Ananya",
      "Vikram",
      "Meera"
    ];

    for (var i = 0; i < count; i++) {
      var wrapper = document.createElement("div");
      wrapper.className = "person-name-item";

      var badge = document.createElement("span");
      badge.className = "person-name-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = String(i + 1);

      var label = document.createElement("label");
      label.className = "sr-only";
      var inputId = "person-name-" + String(i + 1);
      label.setAttribute("for", inputId);
      label.textContent = "Name of Person " + String(i + 1);

      var input = document.createElement("input");
      input.type = "text";
      input.id = inputId;
      input.name = "personName_" + String(i + 1);
      input.className = "person-name-input";
      input.maxLength = MAX_PERSON_NAME_LENGTH;
      input.autocomplete = "off";
      var sample = samplePlaceholders[i % samplePlaceholders.length];
      input.placeholder = "Person " + String(i + 1) + " (e.g., " + sample + ")";
      input.value =
        typeof draftPersonNames[i] === "string" ? draftPersonNames[i] : "";

      (function (index, inputEl) {
        inputEl.addEventListener("input", function () {
          draftPersonNames[index] = inputEl.value;
        });
      })(i, input);

      wrapper.appendChild(badge);
      wrapper.appendChild(label);
      wrapper.appendChild(input);
      fragment.appendChild(wrapper);
    }

    dom.peopleNamesGrid.appendChild(fragment);
  }

  /**
   * Clears all field-level and summary validation errors from the form.
   */
  function clearValidationErrors(dom) {
    dom.errorSummary.hidden = true;
    while (dom.errorList.firstChild) {
      dom.errorList.removeChild(dom.errorList.firstChild);
    }

    var fields = [
      { input: dom.billAmountInput, error: dom.billAmountError },
      { input: dom.occasionNameInput, error: dom.occasionNameError },
      { input: dom.peopleCountInput, error: dom.peopleCountError }
    ];

    for (var i = 0; i < fields.length; i++) {
      var item = fields[i];
      if (item.input) {
        item.input.removeAttribute("aria-invalid");
      }
      if (item.error) {
        item.error.textContent = "";
        item.error.hidden = true;
      }
    }
  }

  /**
   * Renders validation errors in both field-specific status elements and the
   * top error summary banner.
   */
  function renderValidationErrors(dom, validation) {
    clearValidationErrors(dom);

    var fieldMap = {
      billAmount: {
        input: dom.billAmountInput,
        errorEl: dom.billAmountError
      },
      occasionName: {
        input: dom.occasionNameInput,
        errorEl: dom.occasionNameError
      },
      peopleCount: {
        input: dom.peopleCountInput,
        errorEl: dom.peopleCountError
      }
    };

    var firstInvalidInput = null;

    for (var i = 0; i < validation.errorOrder.length; i++) {
      var key = validation.errorOrder[i];
      var message = validation.fieldErrors[key];
      var target = fieldMap[key];

      if (target && message) {
        target.input.setAttribute("aria-invalid", "true");
        target.errorEl.textContent = message;
        target.errorEl.hidden = false;

        var summaryItem = document.createElement("li");
        summaryItem.textContent = message;
        dom.errorList.appendChild(summaryItem);

        if (!firstInvalidInput) {
          firstInvalidInput = target.input;
        }
      }
    }

    dom.errorSummary.hidden = false;

    if (firstInvalidInput) {
      firstInvalidInput.focus();
    }
  }

  /**
   * Renders a verified calculation result into Page 2 using safe DOM APIs
   * (`createElement` and `textContent` only—never `innerHTML` with user content).
   *
   * @param {object} dom - Cached DOM elements.
   * @param {object} calculation - Verified calculation object.
   * @param {boolean} isRestored - Whether this result was restored from localStorage on load.
   */
  function renderResult(dom, calculation, isRestored) {
    if (
      !calculation ||
      !Array.isArray(calculation.sharesPaise) ||
      calculation.sharesPaise.length !== calculation.peopleCount ||
      calculation.allocatedSumPaise !== calculation.totalPaise
    ) {
      return;
    }

    var personNames = normalizePersonNames(
      calculation.personNames,
      calculation.peopleCount
    );
    calculation.personNames = personNames;
    currentCalculation = calculation;

    dom.emptyState.hidden = true;
    dom.resultsContainer.hidden = false;
    dom.savedIndicator.hidden = !isRestored;

    // 1. Occasion Name
    dom.resultOccasion.textContent = calculation.occasion;

    // 2. Total Bill & Group Size
    var formattedTotal = formatPaiseToINR(calculation.totalPaise);
    dom.resultTotalBill.textContent = formattedTotal;
    dom.resultGroupSize.textContent =
      calculation.peopleCount === 1
        ? "1 person"
        : String(calculation.peopleCount) + " people";

    // 3. Prominent Per-Person Summary & Remainder Explanation Note (using actual names!)
    var baseFormatted = formatPaiseToINR(calculation.baseSharePaise);
    if (calculation.remainderPaise === 0) {
      dom.resultPerPersonSummary.textContent = baseFormatted + " each";
      dom.resultRoundingNote.textContent = "";
      dom.resultRoundingNote.hidden = true;
    } else {
      var higherFormatted = formatPaiseToINR(calculation.baseSharePaise + 1);
      dom.resultPerPersonSummary.textContent =
        higherFormatted + " / " + baseFormatted;

      var extraCount = calculation.remainderPaise;
      var regularCount = calculation.peopleCount - calculation.remainderPaise;

      var extraNamesSlice = personNames.slice(0, extraCount);
      var extraLabel =
        extraCount === 1
          ? extraNamesSlice[0] +
            " pays " +
            higherFormatted +
            " (includes +₹0.01 remainder paise)"
          : extraNamesSlice.join(", ") +
            " each pay " +
            higherFormatted +
            " (includes +₹0.01 remainder paise)";

      var regularLabel =
        regularCount === 1
          ? "1 person pays " + baseFormatted
          : String(regularCount) + " people each pay " + baseFormatted;

      dom.resultRoundingNote.textContent =
        "Uneven split resolved fairly: " +
        extraLabel +
        "; remaining " +
        regularLabel +
        ".";
      dom.resultRoundingNote.hidden = false;
    }

    // 4. Individual Named Person Rows
    dom.sharesCountLabel.textContent =
      calculation.peopleCount === 1
        ? "1 named share"
        : String(calculation.peopleCount) + " named shares";

    while (dom.sharesList.firstChild) {
      dom.sharesList.removeChild(dom.sharesList.firstChild);
    }

    var fragment = document.createDocumentFragment();

    for (var i = 0; i < calculation.sharesPaise.length; i++) {
      var sharePaise = calculation.sharesPaise[i];
      var personDisplayName = personNames[i];
      var receivesExtraPaisa =
        calculation.remainderPaise > 0 && i < calculation.remainderPaise;

      var rowItem = document.createElement("li");
      rowItem.className = receivesExtraPaisa
        ? "share-row share-row-extra"
        : "share-row";

      var personContainer = document.createElement("span");
      personContainer.className = "share-person";

      var personNameText = document.createTextNode(personDisplayName);
      personContainer.appendChild(personNameText);

      if (receivesExtraPaisa) {
        var remainderBadge = document.createElement("span");
        remainderBadge.className = "share-note";
        remainderBadge.textContent = "(+₹0.01 remainder paise)";
        personContainer.appendChild(remainderBadge);
      }

      var amountSpan = document.createElement("span");
      amountSpan.className = "share-amount";
      amountSpan.textContent = formatPaiseToINR(sharePaise);

      rowItem.appendChild(personContainer);
      rowItem.appendChild(amountSpan);
      fragment.appendChild(rowItem);
    }

    dom.sharesList.appendChild(fragment);

    // 5. Total Allocation Verification Line
    var formattedAllocated = formatPaiseToINR(calculation.allocatedSumPaise);
    dom.verificationMessage.textContent =
      "Total allocated: " +
      formattedAllocated +
      " / " +
      formattedTotal +
      " (100% reconciled across " +
      (calculation.peopleCount === 1
        ? personNames[0] + ")"
        : String(calculation.peopleCount) + " people)");

    // 6. Accessible Live Region Announcement
    if (dom.statusAnnouncer) {
      dom.statusAnnouncer.textContent =
        (isRestored ? "Restored saved split for " : "Calculated split for ") +
        calculation.occasion +
        ". Total allocated: " +
        formattedAllocated +
        " out of " +
        formattedTotal +
        ".";
    }
  }

  /**
   * Resets the form inputs and clears validation errors without deleting localStorage,
   * then hides the current calculation view and scrolls back to Page 1.
   */
  function resetForm(dom, announcement) {
    clearValidationErrors(dom);
    dom.form.reset();
    dom.occasionNameInput.value = "";
    dom.billAmountInput.value = "";
    dom.peopleCountInput.value = "";
    draftPersonNames = [];
    renderPersonNameInputs(dom, null);

    currentCalculation = null;

    dom.resultsContainer.hidden = true;
    dom.savedIndicator.hidden = true;
    dom.emptyState.hidden = false;

    while (dom.sharesList.firstChild) {
      dom.sharesList.removeChild(dom.sharesList.firstChild);
    }

    if (dom.statusAnnouncer && announcement) {
      dom.statusAnnouncer.textContent = announcement;
    }

    if (dom.entryPage && typeof dom.entryPage.scrollIntoView === "function") {
      dom.entryPage.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    dom.billAmountInput.focus();
  }

  /**
   * Removes the saved calculation from localStorage and resets the form and UI
   * back to the clean empty state.
   */
  function clearSavedResult(dom) {
    try {
      if (window.localStorage) {
        window.localStorage.removeItem(STORAGE_KEY);
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      }
    } catch (err) {
      // Ignore storage errors in restricted environments
    }

    resetForm(
      dom,
      "Saved bill calculation cleared. Ready to enter a new bill."
    );
  }

  /**
   * Populates the form fields and participant name inputs to reflect a restored calculation.
   */
  function syncFormInputsWithCalculation(dom, calculation) {
    dom.occasionNameInput.value = calculation.occasion;
    var wholeRupees = Math.floor(calculation.totalPaise / 100);
    var remainderPaise = calculation.totalPaise % 100;
    var paiseDigits =
      remainderPaise < 10 ? "0" + String(remainderPaise) : String(remainderPaise);
    dom.billAmountInput.value = String(wholeRupees) + "." + paiseDigits;
    dom.peopleCountInput.value = String(calculation.peopleCount);

    draftPersonNames = Array.isArray(calculation.personNames)
      ? calculation.personNames.map(function (name, idx) {
          return name === "Person " + String(idx + 1) ? "" : name;
        })
      : [];
    renderPersonNameInputs(dom, calculation.peopleCount);
  }

  /* ==========================================================================
     7. Initialization & Event Listeners
     ========================================================================== */

  function initApp() {
    var dom = {
      entryPage: document.getElementById("entry-page"),
      outputPanel: document.getElementById("output-panel"),
      pizzaSliceLines: document.getElementById("pizza-slice-lines"),
      pizzaSliceCaption: document.getElementById("pizza-slice-caption"),
      form: document.getElementById("bill-form"),
      billAmountInput: document.getElementById("bill-amount"),
      occasionNameInput: document.getElementById("occasion-name"),
      peopleCountInput: document.getElementById("people-count"),
      peopleNamesGrid: document.getElementById("people-names-grid"),
      peopleNamesPlaceholder: document.getElementById(
        "people-names-placeholder"
      ),
      clearNamesBtn: document.getElementById("clear-names-btn"),
      errorSummary: document.getElementById("form-error-summary"),
      errorList: document.getElementById("form-error-list"),
      billAmountError: document.getElementById("bill-amount-error"),
      occasionNameError: document.getElementById("occasion-name-error"),
      peopleCountError: document.getElementById("people-count-error"),
      emptyState: document.getElementById("empty-state"),
      resultsContainer: document.getElementById("results-container"),
      savedIndicator: document.getElementById("saved-state-indicator"),
      statusAnnouncer: document.getElementById("status-announcer"),
      resultOccasion: document.getElementById("result-occasion"),
      resultTotalBill: document.getElementById("result-total-bill"),
      resultGroupSize: document.getElementById("result-group-size"),
      resultPerPersonSummary: document.getElementById(
        "result-per-person-summary"
      ),
      resultRoundingNote: document.getElementById("result-rounding-note"),
      sharesCountLabel: document.getElementById("shares-count-label"),
      sharesList: document.getElementById("shares-list"),
      verificationMessage: document.getElementById("verification-message"),
      splitAnotherBtn: document.getElementById("split-another-btn"),
      clearSavedBtn: document.getElementById("clear-saved-btn")
    };

    if (!dom.form || !dom.resultsContainer || !dom.emptyState) {
      return;
    }

    // Dynamically update participant name fields and pizza slices when people count changes
    if (dom.peopleCountInput) {
      dom.peopleCountInput.addEventListener("input", function () {
        var raw = dom.peopleCountInput.value.trim();
        if (/^\d+$/.test(raw)) {
          var count = parseInt(raw.replace(/^0+(?=\d)/, ""), 10);
          if (
            Number.isSafeInteger(count) &&
            count >= MIN_PEOPLE &&
            count <= MAX_PEOPLE
          ) {
            renderPersonNameInputs(dom, count);
            return;
          }
        }
        renderPersonNameInputs(dom, null);
      });
    }

    // Clear all custom participant names when "Clear names" is clicked
    if (dom.clearNamesBtn) {
      dom.clearNamesBtn.addEventListener("click", function () {
        draftPersonNames = [];
        if (dom.peopleNamesGrid) {
          var inputs = dom.peopleNamesGrid.querySelectorAll(
            "input.person-name-input"
          );
          for (var i = 0; i < inputs.length; i++) {
            inputs[i].value = "";
          }
          if (inputs.length > 0) {
            inputs[0].focus();
          }
        }
      });
    }

    // Handle form submission
    dom.form.addEventListener("submit", function (event) {
      event.preventDefault();

      var enteredNames = collectEnteredPersonNames(dom);

      var validation = validateInputs(
        dom.occasionNameInput.value,
        dom.billAmountInput.value,
        dom.peopleCountInput.value,
        enteredNames
      );

      if (!validation.valid) {
        renderValidationErrors(dom, validation);
        return;
      }

      clearValidationErrors(dom);

      try {
        var splitData = splitBillExactly(
          validation.data.totalPaise,
          validation.data.peopleCount
        );

        var calculation = {
          occasion: validation.data.occasion,
          totalPaise: splitData.totalPaise,
          peopleCount: splitData.peopleCount,
          personNames: validation.data.personNames,
          baseSharePaise: splitData.baseSharePaise,
          remainderPaise: splitData.remainderPaise,
          sharesPaise: splitData.sharesPaise,
          allocatedSumPaise: splitData.allocatedSumPaise
        };

        dom.occasionNameInput.value = calculation.occasion;

        saveResult(calculation);
        renderResult(dom, calculation, false);

        // Smoothly scroll down to Page 2 so the user immediately sees the named bill breakdown
        if (
          dom.outputPanel &&
          typeof dom.outputPanel.scrollIntoView === "function"
        ) {
          dom.outputPanel.scrollIntoView({
            behavior: "smooth",
            block: "start"
          });
        }
      } catch (err) {
        renderValidationErrors(dom, {
          fieldErrors: {
            billAmount:
              "Unable to calculate an exact split for the provided values. Please check your inputs."
          },
          errorOrder: ["billAmount"]
        });
      }
    });

    // Clear individual field error states when the user edits an invalid field
    var watchedInputs = [
      { input: dom.billAmountInput, errorEl: dom.billAmountError },
      { input: dom.occasionNameInput, errorEl: dom.occasionNameError },
      { input: dom.peopleCountInput, errorEl: dom.peopleCountError }
    ];

    watchedInputs.forEach(function (entry) {
      if (!entry.input) {
        return;
      }
      entry.input.addEventListener("input", function () {
        if (entry.input.getAttribute("aria-invalid") === "true") {
          entry.input.removeAttribute("aria-invalid");
          if (entry.errorEl) {
            entry.errorEl.textContent = "";
            entry.errorEl.hidden = true;
          }
          var anyRemainingInvalid = watchedInputs.some(function (item) {
            return (
              item.input &&
              item.input.getAttribute("aria-invalid") === "true"
            );
          });
          if (!anyRemainingInvalid) {
            dom.errorSummary.hidden = true;
          }
        }
      });
    });

    if (dom.splitAnotherBtn) {
      dom.splitAnotherBtn.addEventListener("click", function () {
        resetForm(dom, "Ready to enter another bill.");
      });
    }

    if (dom.clearSavedBtn) {
      dom.clearSavedBtn.addEventListener("click", function () {
        clearSavedResult(dom);
      });
    }

    // Restore last valid saved calculation on initial load, if valid
    var restored = restoreResult();
    if (restored) {
      syncFormInputsWithCalculation(dom, restored);
      renderResult(dom, restored, true);
    } else {
      updatePizzaDiagram(dom, null);
      dom.resultsContainer.hidden = true;
      dom.savedIndicator.hidden = true;
      dom.emptyState.hidden = false;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
