use anyrender::ImageRenderer;
use anyrender_vello::VelloImageRenderer;
use blitz_dom::Document;
use render::NativeDocument;
use std::path::Path;

pub fn save(doc: &mut NativeDocument, path: &Path) {
    let viewport = doc.inner().viewport().clone();
    let (width, height) = viewport.window_size;
    let mut renderer = VelloImageRenderer::new(width, height);
    doc.resolve_layout(0.0);
    let mut pixels = Vec::new();
    renderer.render_to_vec(
        |scene| {
            blitz_paint::paint_scene(
                scene,
                &mut doc.inner_mut(),
                viewport.hidpi_scale as f64,
                width,
                height,
                0,
                0,
            );
        },
        &mut pixels,
    );
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let file = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&pixels)
        .unwrap();
    println!("{}", path.display());
}
