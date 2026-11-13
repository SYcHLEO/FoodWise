
import pandas as pd
import joblib
from pathlib import Path

from sklearn.model_selection import train_test_split
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder
from sklearn.pipeline import Pipeline
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

# Project paths
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_PATH = BASE_DIR / "data" / "food_waste_raw_1000.csv"
MODEL_PATH = BASE_DIR / "model" / "demand_model.pkl"

# Load dataset
df = pd.read_csv(DATA_PATH)

# Prepare date features
df["date"] = pd.to_datetime(df["date"])
df["month"] = df["date"].dt.month
df["day"] = df["date"].dt.day

# Features and target
features = [
    "product",
    "quantity",
    "price",
    "expiry_days",
    "temperature",
    "day_of_week",
    "is_weekend",
    "month",
    "day"
]

target = "predicted_demand"

X = df[features]
y = df[target]

# Preprocessing
preprocessor = ColumnTransformer(
    transformers=[
        ("product", OneHotEncoder(handle_unknown="ignore"), ["product"])
    ],
    remainder="passthrough"
)

# Machine learning model
model = Pipeline([
    ("preprocessor", preprocessor),
    ("regressor", RandomForestRegressor(
        n_estimators=300,
        max_depth=12,
        min_samples_split=4,
        random_state=42
    ))
])

# Split data
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.20, random_state=42
)

# Train
print("Training FoodWise demand prediction model...")
model.fit(X_train, y_train)

# Evaluate
predictions = model.predict(X_test)

mae = mean_absolute_error(y_test, predictions)
rmse = mean_squared_error(y_test, predictions) ** 0.5
r2 = r2_score(y_test, predictions)

print("\nMODEL EVALUATION")
print("-------------------------")
print(f"MAE:  {mae:.2f}")
print(f"RMSE: {rmse:.2f}")
print(f"R2:   {r2:.3f}")

# Save model
joblib.dump(model, MODEL_PATH)

print("\nModel saved successfully!")
print(f"Location: {MODEL_PATH}")
