# Otterra
# Image to 3D Asset with TRELLIS

Thanks to the incredible work of [JeffreyXiang/TRELLIS-image-large](https://huggingface.co/spaces/JeffreyXiang/TRELLIS-image-large), this project leverages the TRELLIS 3D pipeline to generate high-quality 3D assets from a single image.

## Highlights

- **Single-image 3D asset generation**
- **.glb extraction** with mesh simplification and textures
- **.ply extraction** for Gaussian splatting
- **Public API endpoints** for fast, automated generation and download
- Optional background removal with `rembg`
- Experimental support for **multi-view input**

---

## Usage

### API Endpoints
You can use the Hugging Face space programmatically via `gradio_client` or any HTTP client.

#### 1. `quick_generate_glb`
- Converts a single image to a downloadable `.glb` file (optimized mesh + texture).
- Ideal for real-time applications, web viewers, or AR/VR.

#### 2. `quick_generate_gs`
- Converts an image into a `.ply` file using Gaussian Splatting.
- Great for high-fidelity experimental visualization.

### Example (Python + Gradio Client)

```python
from gradio_client import Client, handle_file

client = Client("JeffreyXiang/TRELLIS")

result = client.predict(
    image=handle_file("your_image_path_or_url.png"),
    api_name="/quick_generate_glb"
)

print("GLB URL:", result)
