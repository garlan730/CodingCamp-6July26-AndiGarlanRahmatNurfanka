/**
 * Expense & Budget Visualizer
 * A client-side SPA for tracking transactions and visualizing spending distribution
 */

// ============================================================================
// Constants
// ============================================================================

/** @typedef {"Food" | "Transport" | "Fun"} Category */

/**
 * Supported transaction categories.
 * @type {Category[]}
 */
const CATEGORIES = ["Food", "Transport", "Fun"];

/**
 * localStorage key used to persist the transactions array.
 * @type {string}
 */
const STORAGE_KEY = "expense-budget-visualizer-transactions";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * @typedef {Object} Transaction
 * @property {string}   id        - UUID (crypto.randomUUID)
 * @property {string}   name      - Item name, 1–100 characters
 * @property {number}   amount    - Positive float, 0.01–999_999_999.99
 * @property {Category} category  - "Food" | "Transport" | "Fun"
 * @property {number}   timestamp - Unix ms (Date.now()) at creation
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid
 * @property {{ name?: string, amount?: string, category?: string }} errors
 */

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates the transaction input fields.
 *
 * Rules:
 *  - name: required, 1–100 non-whitespace-only characters
 *  - amount: numeric value in the inclusive range [0.01, 999_999_999.99]
 *  - category: must be one of CATEGORIES
 *
 * @param {string} name     - Raw value from the item-name input
 * @param {string} amount   - Raw value from the amount input (string from DOM)
 * @param {string} category - Selected value from the category dropdown
 * @returns {ValidationResult}
 */
function validate(name, amount, category) {
    const errors = {};

    // --- name validation ---
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (trimmedName.length === 0) {
        errors.name = "Name is required";
    } else if (trimmedName.length > 100) {
        errors.name = "Name is required";
    }

    // --- amount validation ---
    const numericAmount = Number(amount);
    if (
        amount === "" ||
        amount === null ||
        amount === undefined ||
        isNaN(numericAmount) ||
        numericAmount < 0.01 ||
        numericAmount > 999_999_999.99
    ) {
        errors.amount = "Amount must be between 0.01 and 999,999,999.99";
    }

    // --- category validation ---
    if (!CATEGORIES.includes(category)) {
        errors.category = "Please select a category";
    }

    return {
        valid: Object.keys(errors).length === 0,
        errors,
    };
}

// ============================================================================
// Storage
// ============================================================================

/**
 * Loads the transactions array from localStorage.
 *
 * - Returns `[]` if the key is absent, the stored value is not valid JSON,
 *   or the parsed value is not an array.
 * - Logs a console warning on parse errors or non-array results so that
 *   developers can diagnose corrupted storage without surfacing an error to
 *   the user (Requirement 5.2).
 *
 * @returns {Transaction[]}
 */
function loadTransactions() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = JSON.parse(raw || "[]");
        if (!Array.isArray(parsed)) {
            console.warn(
                `[${STORAGE_KEY}] Expected an array in localStorage but got`,
                typeof parsed,
                "— treating as empty dataset."
            );
            return [];
        }
        return parsed;
    } catch (err) {
        console.warn(
            `[${STORAGE_KEY}] Failed to parse localStorage data:`,
            err.message,
            "— treating as empty dataset."
        );
        return [];
    }
}

/**
 * Persists the transactions array to localStorage.
 *
 * Wraps `localStorage.setItem` in a try/catch to handle
 * `QuotaExceededError` and other `DOMException`s (e.g. private-browsing
 * restrictions) without crashing the application (Requirements 5.3, 5.4).
 *
 * @param {Transaction[]} transactions - The current in-memory transactions array.
 * @returns {{ ok: boolean, error?: DOMException }}
 */
function saveTransactions(transactions) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(transactions));
        return { ok: true };
    } catch (err) {
        // DOMException covers QuotaExceededError, SecurityError, etc.
        return { ok: false, error: err };
    }
}

// ============================================================================
// In-Memory State
// ============================================================================

/**
 * The authoritative in-memory list of transactions for the current session.
 * Populated from localStorage on init and kept in sync with every add/delete.
 *
 * @type {Transaction[]}
 */
let transactions = [];

/**
 * The current Chart.js Pie instance, or null if no chart has been rendered yet.
 * Kept at module level so renderChart can update or destroy the existing instance
 * rather than creating a duplicate canvas context on each re-render.
 *
 * @type {import("chart.js").Chart | null}
 */
let chartInstance = null;

// ============================================================================
// State Mutation Functions
// ============================================================================

/**
 * Adds a new transaction to the in-memory array and persists it.
 *
 * Flow:
 *  1. Build a Transaction object with a fresh UUID and current timestamp.
 *  2. Unshift it to the front of the array (newest first).
 *  3. Try to save to localStorage.
 *     - Success → renderAll()
 *     - Failure → revert the unshift, show storage error banner.
 *
 * @param {string}   name     - Validated item name (1–100 chars)
 * @param {number}   amount   - Validated positive amount
 * @param {Category} category - One of "Food" | "Transport" | "Fun"
 * @returns {void}
 */
function addTransaction(name, amount, category) {
    /** @type {Transaction} */
    const transaction = {
        id: crypto.randomUUID(),
        name,
        amount,
        category,
        timestamp: Date.now(),
    };

    transactions.unshift(transaction);

    const result = saveTransactions(transactions);

    if (result.ok) {
        renderAll();
    } else {
        // Revert: remove the item we just unshifted
        transactions.shift();
        showStorageError();
    }
}

/**
 * Removes the transaction with the given id from the in-memory array
 * and persists the updated list.
 *
 * Flow:
 *  1. Save a reference to the current array for potential rollback.
 *  2. Filter out the target transaction.
 *  3. Try to save to localStorage.
 *     - Success → renderAll()
 *     - Failure → restore old array, show storage error banner.
 *
 * @param {string} id - The UUID of the transaction to remove
 * @returns {void}
 */
function deleteTransaction(id) {
    const previousTransactions = transactions;

    transactions = transactions.filter((tx) => tx.id !== id);

    const result = saveTransactions(transactions);

    if (result.ok) {
        renderAll();
    } else {
        // Revert: restore the array to its state before the filter
        transactions = previousTransactions;
        showStorageError();
    }
}

// ============================================================================
// UI Rendering
// ============================================================================

/**
 * Calculates the total balance from all transactions and writes the
 * formatted value to the #balance DOM element.
 *
 * - Sums all `amount` values using Array.reduce.
 * - Formats the result with toLocaleString('en-US', { minimumFractionDigits: 2,
 *   maximumFractionDigits: 2 }) to produce thousands separators and exactly
 *   2 decimal places (e.g. "1,234.56", "-50.00", "0.00").
 * - Empty array → displays "0.00" (reduce initial value of 0 formatted).
 * - Negative sum → toLocaleString naturally prefixes the minus sign.
 *
 * Requirements: 3.2, 3.3, 3.4
 *
 * @param {Transaction[]} transactions - The current list of transactions.
 * @returns {void}
 */
function renderBalance(transactions) {
    const sum = transactions.reduce((acc, tx) => acc + tx.amount, 0);

    const formatted = sum.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });

    const balanceEl = document.getElementById("balance");
    if (balanceEl) {
        balanceEl.textContent = formatted;
    }
}

/**
 * Renders the transaction list to #transaction-list.
 *
 * - Clears any existing <li> items from the list (leaves #empty-msg in place).
 * - If `transactions` is empty: shows #empty-msg.
 * - If `transactions` has items: hides #empty-msg and appends one <li> per
 *   transaction. Because addTransaction uses unshift, iterating in array order
 *   already produces newest-first display (Requirement 2.3).
 *
 * Each <li class="transaction-item"> contains:
 *   <span class="tx-name">       — item name
 *   <span class="tx-amount">     — amount formatted to 2 decimal places
 *   <span class="tx-category">   — category badge
 *   <button class="delete-btn">  — data-id and aria-label="Delete {name}"
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 2.7
 *
 * @param {Transaction[]} transactions - The current list of transactions.
 * @returns {void}
 */
function renderList(transactions) {
    const listEl = document.getElementById("transaction-list");
    const emptyMsg = document.getElementById("empty-msg");

    if (!listEl) return;

    // Remove existing <li> items only (preserve #empty-msg <p> in the DOM)
    const items = listEl.querySelectorAll("li.transaction-item");
    items.forEach((item) => item.remove());

    if (transactions.length === 0) {
        // Show the placeholder message
        if (emptyMsg) emptyMsg.style.display = "";
        return;
    }

    // Hide the placeholder and build rows
    if (emptyMsg) emptyMsg.style.display = "none";

    transactions.forEach((tx) => {
        const li = document.createElement("li");
        li.className = "transaction-item";

        if (tx.amount >= 100) {
            li.classList.add("large-expense");
        }

        const nameSpan = document.createElement("span");
        nameSpan.className = "tx-name";
        nameSpan.textContent = tx.name;

        const amountSpan = document.createElement("span");
        amountSpan.className = "tx-amount";
        amountSpan.textContent = tx.amount.toFixed(2);

        const categorySpan = document.createElement("span");
        categorySpan.className = "tx-category";
        categorySpan.textContent = tx.category;

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "delete-btn";
        deleteBtn.dataset.id = tx.id;
        deleteBtn.setAttribute("aria-label", `Delete ${tx.name}`);
        deleteBtn.textContent = "Delete";

        li.appendChild(nameSpan);
        li.appendChild(amountSpan);
        li.appendChild(categorySpan);
        li.appendChild(deleteBtn);

        listEl.appendChild(li);
    });
}

/**
 * Renders (or updates) the spending-distribution pie chart.
 *
 * Flow:
 *  1. Guard: if Chart.js is not available (window.Chart is undefined), show the
 *     placeholder with a "Chart library unavailable." message and return early.
 *  2. Group transaction amounts by category, initialising every CATEGORIES entry
 *     to 0 so missing categories are never undefined.
 *  3. Filter to only the categories whose total is > 0 (Requirement 4.7).
 *  4. If activeCategories is empty (no transactions, or all sums are zero):
 *     - Destroy the existing chartInstance if one exists.
 *     - Show #chart-placeholder, hide #chart-canvas, and return.
 *  5. Otherwise:
 *     - Hide #chart-placeholder, show #chart-canvas.
 *     - If chartInstance already exists: mutate its data arrays and call
 *       chartInstance.update() (avoids flickering on re-render).
 *     - Else: create a new Chart.js Pie instance and assign it to chartInstance.
 *
 * Requirements: 4.1, 4.2, 4.5, 4.6, 4.7
 *
 * @param {Transaction[]} transactions - The current list of transactions.
 * @returns {void}
 */
function renderChart(transactions) {
    const placeholder = document.getElementById("chart-placeholder");
    const canvas = document.getElementById("chart-canvas");

    const isDark =
    document.body.classList.contains("dark");

    const legendColor =
    isDark ? "#ffffff" : "#1e293b";

    // Guard: Chart.js must be loaded via CDN before app.js
    if (!window.Chart) {
        if (placeholder) {
            placeholder.textContent = "Chart library unavailable.";
            placeholder.hidden = false;
        }
        if (canvas) canvas.style.display = "none";
        return;
    }

    // Step 1: Group amounts by category
    const totals = {};
    CATEGORIES.forEach((cat) => {
        totals[cat] = 0;
    });
    transactions.forEach((tx) => {
        totals[tx.category] = (totals[tx.category] || 0) + tx.amount;
    });

    // Step 2: Keep only categories with a positive total (Requirement 4.7)
    const activeCategories = CATEGORIES.filter((cat) => totals[cat] > 0);

    // Step 3: Nothing to display — destroy chart and show placeholder
    if (activeCategories.length === 0) {
        if (chartInstance) {
            chartInstance.destroy();
            chartInstance = null;
        }
        if (placeholder) placeholder.hidden = false;
        if (canvas) canvas.style.display = "none";
        return;
    }

    // Step 4: Build dataset arrays
    const data = activeCategories.map((cat) => totals[cat]);
    const backgroundColors = { Food: "#FF6384", Transport: "#36A2EB", Fun: "#FFCE56" };
    const colors = activeCategories.map((cat) => backgroundColors[cat]);

    // Hide placeholder, show canvas
    if (placeholder) placeholder.hidden = true;
    if (canvas) canvas.style.display = "";

    if (chartInstance) {
        // Update existing instance to avoid creating duplicate contexts
        chartInstance.data.labels = activeCategories;
        chartInstance.data.datasets[0].data = data;
        chartInstance.data.datasets[0].backgroundColor = colors;
        chartInstance.update();
    } else {
        // Create a fresh Pie chart
        const ctx = canvas.getContext("2d");
        chartInstance = new window.Chart(ctx, {
            type: "pie",
            data: {
                labels: activeCategories,
                datasets: [{ data, backgroundColor: colors }],
            },
            options: {
                responsive: true,
                plugins: {
                    legend: { position: "bottom",
                        labels: {
                            color: legendColor,
                            padding: 20
                        }
                     },
                    tooltip: {
                        callbacks: {
                            label: (context) => {
                                const label = context.label || "";
                                const value = context.parsed;
                                const total = context.dataset.data.reduce(
                                    (a, b) => a + b,
                                    0
                                );
                                const pct =
                                    total > 0
                                        ? ((value / total) * 100).toFixed(1)
                                        : "0.0";
                                return `${label}: $${value.toFixed(2)} (${pct}%)`;
                            },
                        },
                    },
                },
            },
        });
    }
}

/**
 * Re-renders all reactive UI regions (balance, list, chart).
 *
 * @returns {void}
 */
function renderAll() {
    renderBalance(transactions);
    renderList(transactions);
    renderChart(transactions);
}

/**
 * Displays the #storage-error banner to inform the user that a write to
 * localStorage failed (Requirements 1.7, 2.6, 5.5).
 *
 * - Removes inline display:none so the banner becomes visible.
 * - Attaches a one-time dismiss handler on the banner's .dismiss-btn so that
 *   repeated calls to showStorageError() after the first dismissal still work
 *   (the flag prevents stacking multiple listeners).
 *
 * @returns {void}
 */
function showStorageError() {
    const banner = document.getElementById("storage-error");
    if (!banner) return;

    // Reveal: the HTML ships with style="display: none", so we must
    // remove that inline style (or switch to "block") rather than toggling
    // the `hidden` attribute, which is a separate property.
    banner.style.display = "";

    // Attach dismiss handler only once to avoid stacking listeners.
    if (!banner._dismissAttached) {
        banner._dismissAttached = true;
        const dismissBtn = banner.querySelector(".dismiss-btn");
        if (dismissBtn) {
            dismissBtn.addEventListener("click", () => {
                banner.style.display = "none";
            });
        }
    }
}

// ============================================================================
// Form Event Handlers
// ============================================================================

/**
 * Handles the #input-form submit event.
 *
 * Flow:
 *  1. Prevent default browser form submission.
 *  2. Read raw values from the three fields.
 *  3. Run the validator.
 *  4. On failure: populate each field's adjacent .error-msg span with the
 *     corresponding error text; leave valid field values intact.
 *  5. On success: clear all .error-msg spans, call addTransaction, then
 *     reset name/amount to "" and category back to the placeholder.
 *
 * Requirements: 1.3, 1.4, 1.6
 *
 * @param {Event} event - The form submit event.
 * @returns {void}
 */
function handleAddTransaction(event) {
    event.preventDefault();

    const nameInput     = document.getElementById("item-name");
    const amountInput   = document.getElementById("amount");
    const categoryInput = document.getElementById("category");

    const name     = nameInput.value;
    const amount   = amountInput.value;
    const category = categoryInput.value;

    const errorSpans = document.querySelectorAll(".error-msg");
    // errorSpans[0] = name, [1] = amount, [2] = category (DOM order)

    const { valid, errors } = validate(name, amount, category);

    if (!valid) {
        // Show per-field error messages; leave valid values intact
        errorSpans[0].textContent = errors.name     || "";
        errorSpans[1].textContent = errors.amount   || "";
        errorSpans[2].textContent = errors.category || "";
        return;
    }

    // Clear all error spans on success
    errorSpans.forEach((span) => { span.textContent = ""; });

    addTransaction(name, parseFloat(amount), category);

    // Reset fields to empty / placeholder state (Requirement 1.6)
    nameInput.value     = "";
    amountInput.value   = "";
    categoryInput.value = "";
}

/**
 * Handles click events on the #transaction-list via event delegation.
 *
 * Uses `closest('.delete-btn')` so that clicks on any child element inside
 * the button are still captured correctly. Reads the `data-id` attribute
 * from the matched button and passes it to `deleteTransaction`.
 *
 * Requirements: 2.4, 2.6
 *
 * @param {MouseEvent} event - The click event bubbled up from #transaction-list.
 * @returns {void}
 */
function handleDelete(event) {
    const btn = event.target.closest(".delete-btn");
    if (!btn) return; // Click was not on a delete button — no-op

    const id = btn.dataset.id;
    deleteTransaction(id);
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Attaches all DOM event listeners required by the application.
 *
 * - submit on #input-form        → handleAddTransaction
 * - click  on #transaction-list  → handleDelete (event delegation)
 * - input  on #item-name         → clear adjacent .error-msg (progressive disclosure)
 * - input  on #amount            → clear adjacent .error-msg (progressive disclosure)
 * - change on #category          → clear adjacent .error-msg (progressive disclosure)
 *
 * @returns {void}
 */
function attachEventListeners() {
    const form          = document.getElementById("input-form");
    const listEl        = document.getElementById("transaction-list");
    const nameInput     = document.getElementById("item-name");
    const amountInput   = document.getElementById("amount");
    const categoryInput = document.getElementById("category");

    const sortSelect = document.getElementById("sort");

    if (sortSelect) {
        sortSelect.addEventListener("change", handleSort);
    }

    if (form) {
        form.addEventListener("submit", handleAddTransaction);
    }

    // Event delegation for delete buttons inside the transaction list.
    if (listEl) {
        listEl.addEventListener("click", handleDelete);
    }

    // Progressive disclosure: clear a field's error as soon as the user
    // starts correcting it, so stale errors don't linger.
    if (nameInput) {
        nameInput.addEventListener("input", () => {
            const span = nameInput.closest(".form-group").querySelector(".error-msg");
            if (span) span.textContent = "";
        });
    }

    if (amountInput) {
        amountInput.addEventListener("input", () => {
            const span = amountInput.closest(".form-group").querySelector(".error-msg");
            if (span) span.textContent = "";
        });
    }

    if (categoryInput) {
        categoryInput.addEventListener("change", () => {
            const span = categoryInput.closest(".form-group").querySelector(".error-msg");
            if (span) span.textContent = "";
        });
    }

    const themeBtn =
    document.getElementById("theme-toggle");

    if (themeBtn) {
        themeBtn.addEventListener(
        "click",
        toggleTheme
    );
}


}

/**
 * Initialize the application:
 *  1. Load persisted transactions from localStorage.
 *  2. Render all UI components with the loaded data.
 *  3. Attach DOM event listeners.
 *
 * Requirements: 5.1
 */
function init() {
    transactions = loadTransactions();
    renderAll();
    attachEventListeners();
}

// ============================================================================
// Event Listeners
// ============================================================================

// Wait for DOM to be fully loaded before initializing
document.addEventListener('DOMContentLoaded', init);

// ============================================================================
// Test Exports (Node / Vitest environments only)
// ============================================================================
// This block is intentionally left empty in the browser script.
// The actual exports are provided by js/app.exports.js (an ESM adapter)
// that is imported by the test suite.

const THEME_KEY = "expense-theme";

function loadTheme() {
    const theme = localStorage.getItem(THEME_KEY);

    if (theme === "dark") {
        document.body.classList.add("dark");

        const btn =
            document.getElementById("theme-toggle");

        if (btn) {
            btn.textContent = "☀️";
        }
    }
}


function toggleTheme() {
    document.body.classList.toggle("dark");

    const btn =
        document.getElementById("theme-toggle");

    const isDark =
        document.body.classList.contains("dark");

    if (isDark) {
        localStorage.setItem(THEME_KEY, "dark");
        btn.textContent = "☀️";
    } else {
        localStorage.setItem(THEME_KEY, "light");
        btn.textContent = "🌙";
    }

    renderChart(transactions);
}

function handleSort() {
    const sort = document.getElementById("sort").value;

    if (sort === "amount") {
        transactions.sort((a, b) => b.amount - a.amount);
    }

    if (sort === "category") {
        transactions.sort((a, b) =>
            a.category.localeCompare(b.category)
        );
    }

    if (sort === "latest") {
        transactions.sort((a, b) =>
            b.timestamp - a.timestamp
        );
    }

    renderAll();
}

function init() {
    transactions = loadTransactions();

    loadTheme();

    renderAll();

    attachEventListeners();
}

chartInstance.options.plugins.legend.labels.color =
    legendColor;

chartInstance.update();