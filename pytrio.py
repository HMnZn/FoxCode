from openai import OpenAI

BASE_URL = "https://pytrio.com/api/openai/v1"
MODEL_PATH = "Qwen/Qwen3.5-4B"  # 权重路径或基模名称

api_key = "trio_wNs668Ei7DySxYZNYHfNTqOFwlJs2WjZGDIyn"  # 你的TRIO API Key

client = OpenAI(
    base_url=BASE_URL,
    api_key=api_key,
)

response = client.chat.completions.create(
    model=MODEL_PATH,
    messages=[{"role": "user", "content": "what's your name？"}],
    max_tokens=50,
    temperature=0.7,
    top_p=0.9,
)
print(response)
print(f"{response.choices[0].message.content}")