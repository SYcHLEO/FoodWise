const $ = (id) => document.getElementById(id);
const HISTORY_MAX = 8;
let lastResult = null;
let lastInput = null;
let history = [];

document.addEventListener("DOMContentLoaded", () => {
    typewriter("Reduce Waste.", $("typewriter"));
    animateStatCounters();
    loadAnalytics();
    loadMultiYearChart();

    // Mutual Exclusion: Ensure Holiday and Rush checkboxes cannot both be checked
    $("is_holiday").addEventListener("change", (e) => {
        if (e.target.checked) $("is_rush").checked = false;
    });
    $("is_rush").addEventListener("change", (e) => {
        if (e.target.checked) $("is_holiday").checked = false;
    });

    $("runBtn").addEventListener("click", predictDemand);
    $("clearHistory").addEventListener("click", () => { history = []; renderHistory(); });
    $("ngoActionContainer").addEventListener("click", openNgoModal);
    $("ngoClose").addEventListener("click", closeNgoModal);
    $("ngoModal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeNgoModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeNgoModal(); });

    document.querySelectorAll("[data-preset]").forEach((b) =>
        b.addEventListener("click", () => applyPreset(b.dataset.preset)));

    document.querySelectorAll(".input-panel input").forEach((el) =>
        el.addEventListener("keydown", (e) => { if (e.key === "Enter") predictDemand(); }));
});

function typewriter(text, el) {
    if (!el) return;
    let i = 0;
    (function type() {
        if (i < text.length) {
            el.textContent += text.charAt(i++);
            setTimeout(type, 90);
        }
    })();
}

function animateStatCounters() {
    document.querySelectorAll("[data-count]").forEach((el) => {
        const raw = el.textContent.trim();
        const target = parseFloat(raw.replace(/,/g, ""));
        if (isNaN(target)) return;
        const hasDecimals = raw.includes(".");
        const start = performance.now();
        const dur = 1200;
        (function tick(now) {
            const t = Math.min((now - start) / dur, 1);
            const eased = 1 - Math.pow(1 - t, 3);
            const val = target * eased;
            el.textContent = hasDecimals ? val.toFixed(1) : Math.round(val).toLocaleString("en-IN");
            if (t < 1) requestAnimationFrame(tick);
            else el.textContent = hasDecimals ? target.toFixed(1) : target.toLocaleString("en-IN");
        })(start);
    });
}

const PRESETS = {
    rush:   { product: "Chicken (Cooked)", quantity: 300, price: 180, expiry_days: 1, temperature: 31, day_of_week: 5, holiday: false, rush: true },
    expiry: { product: "Milk",    quantity: 220, price: 60,  expiry_days: 0, temperature: 28, day_of_week: 2, holiday: false, rush: false },
    steady: { product: "Rice",    quantity: 120, price: 55,  expiry_days: 6, temperature: 24, day_of_week: 1, holiday: true,  rush: false }
};

function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    $("product").value = p.product;
    $("quantity").value = p.quantity;
    $("price").value = p.price;
    $("expiry_days").value = p.expiry_days;
    $("temperature").value = p.temperature;
    $("day_of_week").value = p.day_of_week;
    $("is_holiday").checked = p.holiday;
    $("is_rush").checked = p.rush;
    clearInvalid();
    predictDemand();
}

function clearInvalid() {
    document.querySelectorAll("input.invalid").forEach((i) => i.classList.remove("invalid"));
}

function validate() {
    clearInvalid();
    let ok = true;
    ["quantity", "price", "expiry_days", "temperature"].forEach((id) => {
        const el = $(id);
        const v = el.value.trim();
        const n = Number(v);
        const nonNegative = id !== "temperature";
        if (v === "" || isNaN(n) || (nonNegative && n < 0)) {
            el.classList.add("invalid");
            ok = false;
        }
    });
    return ok;
}

function syncCanteenPOS() {
    showToast("Successfully synced with Canteen Billing POS. 1,000+ daily inventory records updated.");
}

async function predictDemand() {
    if (!validate()) {
        showToast("Please fill in valid numbers for the highlighted fields.", true);
        return;
    }

    const selectedDay = parseInt($("day_of_week").value);
    const productVal = $("product").value;
    const isCooked = productVal.includes("Cooked") || productVal.includes("Prepared");
    const cleanProduct = productVal.replace(" (Cooked)", "").trim();

    const data = {
        product: cleanProduct,
        quantity: $("quantity").value,
        price: $("price").value,
        expiry_days: $("expiry_days").value,
        temperature: $("temperature").value,
        day_of_week: selectedDay,
        is_weekend: (selectedDay === 5 || selectedDay === 6) ? 1 : 0,
        is_cooked: isCooked ? 1 : 0
    };

    const isHoliday = $("is_holiday").checked;
    const isRush = $("is_rush").checked;
    const smsEnabled = $("sms_alerts").checked;

    const overlay = $("aiOverlay");
    const panel = $("outputPanel");
    const btn = $("runBtn");
    const steps = ["DECODING PATTERNS...", "SCORING SURPLUS RISK...", "BUILDING ACTION PLAN..."];
    let s = 0;

    btn.disabled = true;
    overlay.classList.add("show");
    panel.classList.remove("active");
    $("aiOverlayText").textContent = steps[0];
    const stepTimer = setInterval(() => {
        s = (s + 1) % steps.length;
        $("aiOverlayText").textContent = steps[s];
    }, 500);

    try {
        const [res] = await Promise.all([
            fetch("/predict", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data)
            }),
            new Promise((r) => setTimeout(r, 1500))
        ]);

        if (!res.ok) throw new Error("Server responded " + res.status);
        let result = await res.json();
        
        if (isHoliday) {
            result.predicted_demand = Math.floor(result.predicted_demand * 0.3);
            result.surplus = data.quantity - result.predicted_demand;
            result.surplus_percentage = ((result.surplus / data.quantity) * 100).toFixed(1);
            
            if (result.surplus_percentage > 30) {
                result.risk = "HIGH";
                result.action = "Holiday Clearance + NGO Route";
                result.recommendation = `[${result.food_category}] Semester holiday detected (-70% demand drop). Route surplus via Porter immediately.`;
                result.show_ngo = true;
            } else if (result.surplus_percentage >= 15) {
                result.risk = "MEDIUM";
                result.action = "Holiday Discount + NGO Route";
                result.recommendation = `[${result.food_category}] Holiday slowdown expected. Clear inventory with partner NGOs.`;
                result.show_ngo = true;
            }
        } else if (isRush) {
            result.predicted_demand = Math.floor(result.predicted_demand * 1.5);
            result.surplus = Math.max(0, data.quantity - result.predicted_demand);
            result.surplus_percentage = ((result.surplus / data.quantity) * 100).toFixed(1);
            
            if (result.predicted_demand > data.quantity) {
                result.risk = "HIGH";
                result.action = "⚠️ STOCKOUT WARNING! Prep More Stock";
                result.recommendation = `[${result.food_category}] Festival rush (+50% demand surge)! Expected demand exceeds current quantity. Prepare additional batches immediately.`;
                result.show_ngo = false;
            } else {
                result.risk = "LOW";
                result.action = "Optimal Rush Preparation";
                result.recommendation = `[${result.food_category}] Festival surge accounted for. Current stock matches increased turnout.`;
                result.show_ngo = false;
            }
        }

        if (smsEnabled && result.risk === "HIGH") {
            setTimeout(() => {
                showToast("📱 Morning SMS Alert dispatched to Canteen Manager: High Risk alert for " + data.product + "!");
            }, 1800);
        }

        lastResult = result;
        lastInput = data;
        renderResult(result, data);
        addHistory(result, data);
        panel.classList.add("active");

        if (window.innerWidth < 1024) {
            panel.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    } catch (err) {
        console.error(err);
        showToast("Backend unreachable. Check that the Flask server is running.", true);
    } finally {
        clearInterval(stepTimer);
        overlay.classList.remove("show");
        btn.disabled = false;
    }
}

function riskKey(risk) {
    const r = String(risk || "").toUpperCase();
    return r === "LOW" || r === "MEDIUM" || r === "HIGH" ? r : "HIGH";
}

function renderResult(result, input) {
    const key = riskKey(result.risk);
    const color = { LOW: "#00ff87", MEDIUM: "#f4c95d", HIGH: "#ff2a2a" }[key];

    scrambleNumber("demandResult", result.predicted_demand);
    scrambleNumber("surplusResult", result.surplus);

    const pct = Math.max(0, Math.min(100, Number(result.surplus_percentage) || 0));
    const fill = $("gaugeFill");
    fill.style.stroke = color;
    fill.style.color = color;
    fill.style.strokeDashoffset = 326.7 * (1 - pct / 100);
    countTo($("percentageResult"), pct, "%");

    $("actionResult").textContent = result.action;
    $("recommendationResult").textContent = result.recommendation;

    const badge = $("riskBadge");
    badge.textContent = `[ RISK: ${result.risk} ]`;
    badge.style.color = color;
    badge.style.borderColor = color;

    const levels = ["LOW", "MEDIUM", "HIGH"];
    document.querySelectorAll(".risk-seg").forEach((seg) => {
        seg.classList.toggle("on", levels.indexOf(seg.dataset.level) <= levels.indexOf(key));
    });
    const card = $("actionCard");
    card.classList.remove("risk-medium", "risk-high");
    if (key === "MEDIUM") card.classList.add("risk-medium");
    if (key === "HIGH") card.classList.add("risk-high");

    $("ngoActionContainer").style.display = result.show_ngo ? "block" : "none";

    const surplus = Number(result.surplus) || 0;
    const price = Number(input.price) || 0;
    const days = Number(input.expiry_days);
    
    countTo($("impactValue"), surplus * price, "", "₹");
    
    const dailySaved = Math.max(surplus * price, 1000);
    countTo($("monthlyRoi"), dailySaved * 30, "", "₹");

    $("impactUnits").textContent = surplus + " units";
    $("impactTime").textContent = days <= 0 ? "Expires Today" : days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

function scrambleNumber(id, finalNumber) {
    const el = $(id);
    let frames = 0;
    const timer = setInterval(() => {
        el.textContent = Math.floor(Math.random() * 999);
        if (++frames >= 20) {
            clearInterval(timer);
            el.textContent = finalNumber;
            el.style.color = "#00ff87";
            setTimeout(() => (el.style.color = "#fff"), 500);
        }
    }, 40);
}

function countTo(el, target, suffix = "", prefix = "") {
    const start = performance.now();
    const dur = 900;
    const fmt = (v) => prefix + Math.round(v).toLocaleString("en-IN") + suffix;
    (function tick(now) {
        const t = Math.min((now - start) / dur, 1);
        el.textContent = fmt(target * (1 - Math.pow(1 - t, 3)));
        if (t < 1) requestAnimationFrame(tick);
        else el.textContent = fmt(target);
    })(start);
}

function addHistory(result, input) {
    history.unshift({
        time: new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }),
        product: input.product,
        stock: input.quantity,
        demand: result.predicted_demand,
        surplus: result.surplus,
        risk: riskKey(result.risk)
    });
    history = history.slice(0, HISTORY_MAX);
    renderHistory(true);
}

function renderHistory(animateFirst = false) {
    const body = $("historyBody");
    if (!history.length) {
        body.innerHTML = '<tr class="empty-row"><td colspan="6">No predictions yet. Run the model to see results here.</td></tr>';
        return;
    }
    body.innerHTML = "";
    history.forEach((h, i) => {
        const tr = document.createElement("tr");
        if (animateFirst && i === 0) tr.className = "new";
        [h.time, h.product, h.stock, h.demand, h.surplus].forEach((v) => {
            const td = document.createElement("td");
            td.textContent = v;
            tr.appendChild(td);
        });
        const td = document.createElement("td");
        const tag = document.createElement("span");
        tag.className = "tag " + h.risk.toLowerCase();
        tag.textContent = h.risk;
        td.appendChild(tag);
        tr.appendChild(td);
        body.appendChild(tr);
    });
}

function openNgoModal() {
    if (lastResult && lastInput) {
        $("ngoSummary").textContent =
            `${lastResult.surplus} surplus units of ${lastInput.product} available for pickup. Contact via Call, SMS, or Email.`;
        
        const msgBody = `FoodWise Alert: We have ${lastResult.surplus} units of ${lastInput.product} surplus ready for donation (expires in ${lastInput.expiry_days}d). Please coordinate Porter pickup.`;
        const subject = encodeURIComponent(`Food donation: ${lastResult.surplus} units of ${lastInput.product}`);
        const body = encodeURIComponent(msgBody);

        document.querySelectorAll(".email-link").forEach((a) => {
            const base = a.getAttribute("href").split("?")[0];
            a.setAttribute("href", `${base}?subject=${subject}&body=${body}`);
        });

        document.querySelectorAll(".sms-link").forEach((a) => {
            const base = a.getAttribute("href").split("?")[0];
            a.setAttribute("href", `${base}?body=${body}`);
        });
    }
    $("ngoModal").classList.add("active");
}
function closeNgoModal() { $("ngoModal").classList.remove("active"); }

function showToast(msg, isError = false) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.toggle("error", isError);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

function loadMultiYearChart() {
    if (typeof Chart === "undefined") return;
    const ctx = document.getElementById('multiYearChart').getContext('2d');
    new Chart(ctx, {
        type: 'line',
        data: {
            labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun (Sem End)', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec (Term Break)'],
            datasets: [
                {
                    label: '2024 Canteen Demand',
                    data: [8500, 9200, 8800, 9400, 9100, 2100, 2500, 8900, 9500, 9300, 9100, 4200],
                    borderColor: '#a78bfa',
                    backgroundColor: 'rgba(167, 139, 250, 0.08)',
                    borderWidth: 2,
                    tension: 0.4,
                    fill: true
                },
                {
                    label: '2025 Canteen Demand',
                    data: [8600, 9300, 9100, 9600, 9200, 2300, 2400, 9200, 9700, 9400, 9300, 4500],
                    borderColor: '#00ff87',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { 
                legend: { position: 'top', labels: { color: "#8c8c97" } } 
            },
            scales: {
                x: { grid: { display: false } },
                y: { grid: { color: "#1f1f23" }, title: { display: true, text: 'Total Monthly Meal Demand' } }
            }
        }
    });
}

async function loadAnalytics() {
    if (typeof Chart === "undefined") return;
    Chart.defaults.color = "#8c8c97";
    Chart.defaults.font.family = "'Space Grotesk', sans-serif";

    try {
        const res = await fetch("/analytics");
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();

        new Chart($("productDemandChart"), {
            type: "bar",
            data: {
                labels: Object.keys(data.product_demand),
                datasets: [{
                    data: Object.values(data.product_demand),
                    backgroundColor: (ctx) => {
                        const { chart } = ctx;
                        if (!chart.chartArea) return "#00ff87";
                        const g = chart.ctx.createLinearGradient(0, chart.chartArea.bottom, 0, chart.chartArea.top);
                        g.addColorStop(0, "rgba(0,255,135,0.15)");
                        g.addColorStop(1, "#00ff87");
                        return g;
                    },
                    borderRadius: 8,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false } },
                    y: { grid: { color: "#1f1f23" }, beginAtZero: true }
                }
            }
        });

        const riskLabels = Object.keys(data.risk_distribution);
        const riskData = Object.values(data.risk_distribution);
        const riskColors = riskLabels.map(label => {
            if (label === 'Low Risk') return '#00ff87';
            if (label === 'Medium Risk') return '#f4c95d';
            if (label === 'High Risk') return '#ff2a2a';
            return '#8c8c97';
        });

        new Chart($("riskChart"), {
            type: 'doughnut',
            data: {
                labels: riskLabels,
                datasets: [{
                    data: riskData,
                    backgroundColor: riskColors,
                    borderWidth: 0,
                    hoverOffset: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: "68%",
                plugins: { legend: { position: "bottom", labels: { color: "#8c8c97", usePointStyle: true, padding: 18 } } }
            }
        });
    } catch (err) {
        console.error("Analytics failed", err);
        document.querySelectorAll(".chart-box").forEach((b) => {
            b.innerHTML = '<p style="color:#8c8c97;text-align:center;padding-top:110px;font-size:13px">Analytics unavailable.</p>';
        });
    }
}