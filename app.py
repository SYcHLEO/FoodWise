import os
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
import pandas as pd
import joblib

app = Flask(__name__)
CORS(app)  # Enables cross-origin requests for external API clients

# =====================================================
# LOAD DATA & MODEL (Absolute Path Resolution)
# =====================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(BASE_DIR, "data", "food_waste_raw_1000.csv") 
MODEL_PATH = os.path.join(BASE_DIR, "model", "demand_model.pkl")

print("Loading dataset and model for FoodWise...")
df = pd.read_csv(DATA_PATH)
df["date"] = pd.to_datetime(df["date"])
model = joblib.load(MODEL_PATH)

# =====================================================
# DYNAMIC EXPIRATION & FOOD CLASSIFICATION LOGIC
# =====================================================
def get_food_classification_and_expiry(product_name, is_cooked, temperature):
    prod = product_name.lower()
    
    shelf_life_matrix = {
        "chicken": {"category": "Cooked / Prepared" if is_cooked else "Raw Perishable", "days": 1 if is_cooked else 3},
        "rice": {"category": "Cooked / Prepared" if is_cooked else "Raw Staple", "days": 2 if is_cooked else 180},
        "milk": {"category": "Raw Perishable", "days": 5},
        "bread": {"category": "Raw Staple", "days": 4},
        "eggs": {"category": "Raw Perishable", "days": 21},
        "banana": {"category": "Raw Produce", "days": 5},
        "tomato": {"category": "Raw Produce", "days": 7},
        "apple": {"category": "Raw Produce", "days": 30}
    }
    
    default_data = shelf_life_matrix.get(prod, {"category": "Raw Perishable", "days": 3})
    category = default_data["category"]
    base_days = default_data["days"]
    
    if temperature > 25 and base_days > 1:
        thermal_penalty = int((temperature - 25) * 0.1)
        base_days = max(1, base_days - thermal_penalty)
        
    return category, base_days

# =====================================================
# WEB UI ROUTE
# =====================================================
@app.route('/')
def index():
    total_records = len(df)
    total_quantity = int(df["quantity"].sum())
    total_demand = int(df["predicted_demand"].sum())
    
    df['surplus'] = df['quantity'] - df['predicted_demand']
    df['surplus_pct'] = (df['surplus'] / df['quantity']) * 100
    
    high_risk = len(df[df['surplus_pct'] > 30])
    medium_risk = len(df[(df['surplus_pct'] >= 15) & (df['surplus_pct'] <= 30)])
    low_risk = len(df[df['surplus_pct'] < 15])
    
    return render_template('index.html', 
                           total_records=total_records, total_quantity=total_quantity,
                           total_demand=total_demand, high_risk=high_risk,
                           medium_risk=medium_risk, low_risk=low_risk,
                           average_demand=int(df["predicted_demand"].mean()), 
                           average_quantity=int(df["quantity"].mean()),
                           total_surplus=int(df['surplus'].sum()))

# =====================================================
# REST API ENDPOINT: POST /api/predict
# =====================================================
@app.route('/api/predict', methods=['POST'])
def api_predict():
    try:
        data = request.json
        if not data:
            return jsonify({'error': 'Invalid JSON payload'}), 400

        product_name = data.get('product', 'Rice')
        quantity = float(data.get('quantity', 100))
        price_input = float(data.get('price', 50))
        temperature = float(data.get('temperature', 24))
        is_cooked = bool(data.get('is_cooked', False))
        day_of_week = int(data.get('day_of_week', 0))
        is_weekend = int(data.get('is_weekend', 0))
        
        category, calculated_expiry = get_food_classification_and_expiry(product_name, is_cooked, temperature)
        expiry = float(data.get('expiry_days', calculated_expiry))
        
        input_data = pd.DataFrame([{
            'product': product_name,
            'quantity': quantity,
            'price': price_input,
            'expiry_days': expiry,
            'temperature': temperature,
            'day_of_week': day_of_week,
            'is_weekend': is_weekend,
            'month': 11,
            'day': 13
        }])
        
        prediction = float(model.predict(input_data)[0])
        
        if price_input < 40 and price_input > 0:
            discount_depth = (40 - price_input) / 40  
            prediction = prediction * (1 + discount_depth) 

        predicted_demand = int(round(prediction))
        predicted_demand = min(predicted_demand, int(quantity)) 
        
        surplus = int(quantity - predicted_demand)
        surplus_percentage = round((surplus / quantity) * 100, 1) if quantity > 0 else 0
        
        show_ngo = False
        risk = "LOW"
        action = "Normal Selling"
        recommendation = f"[{category}] Demand matches quantity. No intervention needed."

        if 15 <= surplus_percentage <= 30:
            risk = "MEDIUM"
            if expiry <= 1:
                action = "15% discount + NGO Donation"
                recommendation = f"[{category}] Expiring soon! Spoilage risk is high. Contact NGOs via Porter."
                show_ngo = True
            else:
                action = "Apply 10-15% discount"
                recommendation = f"[{category}] Moderate surplus expected. Discount to clear inventory."
        elif surplus_percentage > 30:
            risk = "HIGH"
            action = "25% discount + NGO Donation"
            recommendation = f"[{category}] High waste risk! Aggressive discounting and immediate donation required."
            show_ngo = True
            
        return jsonify({
            'status': 'success',
            'data': {
                'product': product_name,
                'food_category': category,
                'predicted_demand': predicted_demand,
                'surplus': surplus,
                'surplus_percentage': surplus_percentage,
                'risk': risk,
                'action': action,
                'recommendation': recommendation,
                'show_ngo': show_ngo,
                'dynamic_expiry': expiry
            }
        }), 200
        
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

# =====================================================
# REST API ENDPOINT: GET /api/analytics
# =====================================================
@app.route('/api/analytics', methods=['GET'])
def api_analytics():
    product_demand = df.groupby('product')['predicted_demand'].mean().round(1).to_dict()
    product_quantity = df.groupby('product')['quantity'].mean().round(1).to_dict()
    
    df['surplus_pct'] = ((df['quantity'] - df['predicted_demand']) / df['quantity']) * 100
    risk_dist = {
        'Low Risk': len(df[df['surplus_pct'] < 15]),
        'Medium Risk': len(df[(df['surplus_pct'] >= 15) & (df['surplus_pct'] <= 30)]),
        'High Risk': len(df[df['surplus_pct'] > 30])
    }
    
    return jsonify({
        'status': 'success',
        'product_demand': product_demand,
        'product_quantity': product_quantity,
        'risk_distribution': risk_dist
    }), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)