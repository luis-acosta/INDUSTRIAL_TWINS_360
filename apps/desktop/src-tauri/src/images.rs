//! Recodificación de imágenes al publicar (V01, V02).
//!
//! Está en Rust y no en la vista web por el criterio de reparto del plan: sólo
//! lo que la vista web no puede hacer. Una panorámica equirrectangular de 100
//! megapíxeles en un lienzo del navegador necesita cuatrocientos megabytes de
//! mapa de bits sólo para abrirla, y el navegador la descarta a mitad de
//! proceso sin decir por qué. Son cuarenta por recorrido.
//!
//! Qué decide quién: el **plan** lo calcula TypeScript —qué formato, qué
//! tamaño, qué teselas y con qué nombre—, y aquí se ejecuta. Esa frontera
//! permite probar las decisiones sin compilar Rust, que es lo que se hace, y
//! deja en este módulo sólo lo mecánico.
//!
//! Dos cosas que conviene no perder de vista:
//!
//! **No se agranda nunca.** Si la imagen ya es menor que el lado pedido, se
//! deja. Interpolar píxeles que no existen añade peso sin añadir información.
//!
//! **El filtro de reducción es Lanczos3.** Es más lento que los demás y es el
//! que conserva el detalle fino —rótulos de equipos, escalas de manómetros—
//! que es justamente lo que alguien va a mirar de cerca en una panorámica
//! industrial. En una imagen que se reduce a la octava parte, un filtro
//! barato convierte un número legible en una mancha.

use std::io::Cursor;

use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Formatos que este módulo sabe producir.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetFormat {
    Jpeg,
    Png,
    Webp,
}

#[derive(Debug, Error)]
pub enum ImageError {
    #[error("no se pudo leer la imagen: {0}")]
    Decode(String),
    #[error("no se pudo escribir la imagen: {0}")]
    Encode(String),
    #[error("recorte fuera de la imagen: {0}")]
    Crop(String),
}

/// Petición de recodificación, tal como la manda el plan.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodeRequest {
    pub format: TargetFormat,
    /// 1-100. Se ignora en PNG, que es sin pérdida.
    pub quality: u8,
    /// Lado mayor máximo; 0 = no reescalar.
    pub max_edge_px: u32,
    /// Recorte antes de reescalar, para una tesela.
    pub crop: Option<Crop>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Resultado: los bytes y lo que de verdad se produjo.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodedImage {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub byte_size: usize,
}

/// Reescala si hace falta, respetando la relación de aspecto.
///
/// Devuelve la imagen tal cual cuando ya cabe: una panorámica estirada no se
/// puede proyectar sobre una esfera, y agrandar no añade información.
pub fn fit_within(image: DynamicImage, max_edge_px: u32) -> DynamicImage {
    if max_edge_px == 0 {
        return image;
    }

    let (width, height) = (image.width(), image.height());
    let longest = width.max(height);
    if longest <= max_edge_px {
        return image;
    }

    let factor = f64::from(max_edge_px) / f64::from(longest);
    let target_w = ((f64::from(width) * factor).round() as u32).max(1);
    let target_h = ((f64::from(height) * factor).round() as u32).max(1);

    image.resize_exact(target_w, target_h, FilterType::Lanczos3)
}

/// Recorta una región, acotándola a la imagen.
///
/// Se acota en lugar de fallar: la última tesela de cada fila pide por diseño
/// menos píxeles de los que mide la tesela, y un error ahí pararía la
/// publicación entera por el caso normal.
pub fn crop_region(image: &DynamicImage, crop: Crop) -> Result<DynamicImage, ImageError> {
    if crop.x >= image.width() || crop.y >= image.height() {
        return Err(ImageError::Crop(format!(
            "la región empieza en ({}, {}) y la imagen mide {}×{}",
            crop.x,
            crop.y,
            image.width(),
            image.height()
        )));
    }

    let width = crop.width.min(image.width() - crop.x).max(1);
    let height = crop.height.min(image.height() - crop.y).max(1);

    Ok(image.crop_imm(crop.x, crop.y, width, height))
}

/// Codifica en el formato pedido.
fn write_bytes(image: &DynamicImage, format: TargetFormat, quality: u8) -> Result<Vec<u8>, ImageError> {
    let mut out = Cursor::new(Vec::new());

    match format {
        TargetFormat::Jpeg => {
            // El codificador JPEG toma la calidad en el constructor; el resto
            // de formatos la ignoran o la llevan en sus propias opciones.
            let quality = quality.clamp(1, 100);
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
            // Sin canal alfa: un JPEG con transparencia no existe, y pasarle
            // una imagen RGBA da un resultado con los colores mezclados con
            // negro sin avisar.
            encoder
                .encode_image(&DynamicImage::ImageRgb8(image.to_rgb8()))
                .map_err(|e| ImageError::Encode(e.to_string()))?;
        }
        TargetFormat::Png => {
            image
                .write_to(&mut out, ImageFormat::Png)
                .map_err(|e| ImageError::Encode(e.to_string()))?;
        }
        TargetFormat::Webp => {
            // El codificador WebP de `image` es sin pérdida: no toma calidad.
            // Se deja constancia porque el plan manda una y aquí se ignora, y
            // un lector futuro buscaría el error en el plan.
            image
                .write_to(&mut out, ImageFormat::WebP)
                .map_err(|e| ImageError::Encode(e.to_string()))?;
        }
    }

    Ok(out.into_inner())
}

/// Ejecuta una petición completa: decodificar, recortar, reescalar, codificar.
pub fn encode(bytes: &[u8], request: &EncodeRequest) -> Result<EncodedImage, ImageError> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| ImageError::Decode(e.to_string()))?;

    let decoded = reader.decode().map_err(|e| ImageError::Decode(e.to_string()))?;

    let cropped = match request.crop {
        Some(crop) => crop_region(&decoded, crop)?,
        None => decoded,
    };

    let fitted = fit_within(cropped, request.max_edge_px);
    let out = write_bytes(&fitted, request.format, request.quality)?;

    Ok(EncodedImage {
        width: fitted.width(),
        height: fitted.height(),
        byte_size: out.len(),
        bytes: out,
    })
}

/// Orden desde la vista web.
///
/// Los bytes viajan como vector porque es lo que el puente de Tauri sabe
/// mover; para una panorámica son unas decenas de megabytes y una sola copia,
/// que es asumible frente a lo que cuesta codificarla.
#[tauri::command]
pub fn image_encode(bytes: Vec<u8>, request: EncodeRequest) -> Result<EncodedImage, String> {
    encode(&bytes, &request).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    /// Imagen de prueba con un degradado: un color plano no distinguiría un
    /// reescalado correcto de uno que devuelve la imagen sin tocar.
    fn sample(width: u32, height: u32) -> Vec<u8> {
        let mut image = RgbaImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let r = ((x * 255) / width.max(1)) as u8;
            let g = ((y * 255) / height.max(1)) as u8;
            *pixel = Rgba([r, g, 128, 255]);
        }

        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut out, ImageFormat::Png)
            .expect("la imagen de prueba debe poder escribirse");
        out.into_inner()
    }

    #[test]
    fn test_img_001_reescala_respetando_la_relacion_de_aspecto() {
        // Una panorámica estirada no se puede proyectar sobre una esfera.
        let bytes = sample(800, 400);
        let out = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Jpeg,
                quality: 80,
                max_edge_px: 400,
                crop: None,
            },
        )
        .expect("debe codificar");

        assert_eq!(out.width, 400);
        assert_eq!(out.height, 200);
    }

    #[test]
    fn test_img_002_no_agranda_una_imagen_pequena() {
        // Interpolar píxeles que no existen añade peso sin añadir información.
        let bytes = sample(100, 50);
        let out = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Png,
                quality: 100,
                max_edge_px: 4096,
                crop: None,
            },
        )
        .expect("debe codificar");

        assert_eq!(out.width, 100);
        assert_eq!(out.height, 50);
    }

    #[test]
    fn test_img_003_cero_significa_no_reescalar() {
        let bytes = sample(300, 150);
        let out = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Png,
                quality: 100,
                max_edge_px: 0,
                crop: None,
            },
        )
        .expect("debe codificar");

        assert_eq!((out.width, out.height), (300, 150));
    }

    #[test]
    fn test_img_004_produce_cada_formato_de_verdad() {
        // Se comprueba la firma del archivo, no el nombre: lo que importa es
        // que el navegador del cliente reconozca lo que recibe.
        let bytes = sample(64, 64);

        let jpeg = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Jpeg,
                quality: 70,
                max_edge_px: 0,
                crop: None,
            },
        )
        .expect("jpeg");
        assert_eq!(&jpeg.bytes[0..3], &[0xFF, 0xD8, 0xFF]);

        let png = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Png,
                quality: 100,
                max_edge_px: 0,
                crop: None,
            },
        )
        .expect("png");
        assert_eq!(&png.bytes[0..8], &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

        let webp = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Webp,
                quality: 80,
                max_edge_px: 0,
                crop: None,
            },
        )
        .expect("webp");
        assert_eq!(&webp.bytes[0..4], b"RIFF");
        assert_eq!(&webp.bytes[8..12], b"WEBP");
    }

    #[test]
    fn test_img_005_la_calidad_jpeg_cambia_el_peso() {
        // Si la calidad no llegara al codificador, el ajuste del editor no
        // haría nada y nadie se enteraría.
        let bytes = sample(400, 400);

        let low = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Jpeg,
                quality: 20,
                max_edge_px: 0,
                crop: None,
            },
        )
        .expect("baja");

        let high = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Jpeg,
                quality: 95,
                max_edge_px: 0,
                crop: None,
            },
        )
        .expect("alta");

        assert!(
            low.byte_size < high.byte_size,
            "calidad 20 debería pesar menos que 95: {} vs {}",
            low.byte_size,
            high.byte_size
        );
    }

    #[test]
    fn test_img_006_recorta_una_tesela() {
        let bytes = sample(1000, 500);
        let out = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Png,
                quality: 100,
                max_edge_px: 0,
                crop: Some(Crop {
                    x: 512,
                    y: 0,
                    width: 512,
                    height: 500,
                }),
            },
        )
        .expect("debe recortar");

        // La región pedida se sale por la derecha: se acota a lo que hay.
        assert_eq!(out.width, 488);
        assert_eq!(out.height, 500);
    }

    #[test]
    fn test_img_007_una_tesela_fuera_de_la_imagen_se_denuncia() {
        // Acotar una región que empieza fuera daría una imagen de un píxel sin
        // decir nada, y la tesela saldría en negro en el visor.
        let bytes = sample(100, 100);
        let result = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Png,
                quality: 100,
                max_edge_px: 0,
                crop: Some(Crop {
                    x: 200,
                    y: 0,
                    width: 50,
                    height: 50,
                }),
            },
        );

        assert!(matches!(result, Err(ImageError::Crop(_))));
    }

    #[test]
    fn test_img_008_recorta_antes_de_reescalar() {
        // El orden importa: reescalar primero y recortar después daría una
        // región distinta de la que el plan calculó.
        let bytes = sample(800, 800);
        let out = encode(
            &bytes,
            &EncodeRequest {
                format: TargetFormat::Png,
                quality: 100,
                max_edge_px: 200,
                crop: Some(Crop {
                    x: 0,
                    y: 0,
                    width: 400,
                    height: 400,
                }),
            },
        )
        .expect("debe codificar");

        assert_eq!((out.width, out.height), (200, 200));
    }

    #[test]
    fn test_img_009_un_archivo_que_no_es_imagen_se_denuncia() {
        let result = encode(
            b"esto no es una imagen",
            &EncodeRequest {
                format: TargetFormat::Png,
                quality: 100,
                max_edge_px: 0,
                crop: None,
            },
        );

        assert!(matches!(result, Err(ImageError::Decode(_))));
    }

    #[test]
    fn test_img_010_un_jpeg_con_alfa_no_sale_con_colores_mezclados() {
        // Pasar RGBA al codificador JPEG mezcla los colores con negro sin
        // avisar: el resultado se ve oscuro y nadie sabe por qué.
        let mut image = RgbaImage::new(32, 32);
        for pixel in image.pixels_mut() {
            *pixel = Rgba([255, 0, 0, 0]); // Rojo totalmente transparente.
        }
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut png, ImageFormat::Png)
            .expect("png de prueba");

        let out = encode(
            &png.into_inner(),
            &EncodeRequest {
                format: TargetFormat::Jpeg,
                quality: 90,
                max_edge_px: 0,
                crop: None,
            },
        )
        .expect("debe codificar");

        let decoded = ImageReader::new(Cursor::new(&out.bytes))
            .with_guessed_format()
            .expect("formato")
            .decode()
            .expect("decodificar")
            .to_rgb8();

        let pixel = decoded.get_pixel(16, 16);
        assert!(pixel[0] > 200, "el rojo debe conservarse, salió {pixel:?}");
    }
}
