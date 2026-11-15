use super::*;

pub(super) fn sync(r: &mut Resources, p: &Json) -> Result<Json> {
    match text(p, "op")? {
        "encode" => Ok(json!(text(p, "text")?.as_bytes())),
        "decoder" => {
            r.capacity()?;

            let encoding = encoding_rs::Encoding::for_label(text(p, "label")?.as_bytes())
                .ok_or("unsupported text encoding")?;

            let decoder = if p["ignoreBOM"].as_bool() == Some(true) {
                encoding.new_decoder_without_bom_handling()
            } else {
                encoding.new_decoder_with_bom_removal()
            };

            let id = r.id();
            r.decoders.insert(id, decoder);

            Ok(json!(id))
        }
        "decode" => {
            let bytes = bytes(&p["bytes"])?;

            let decoder = r
                .decoders
                .get_mut(&id(p)?)
                .ok_or("text decoder is closed")?;

            let last = p["last"].as_bool() == Some(true);

            let mut output = String::with_capacity(
                decoder
                    .max_utf8_buffer_length(bytes.len())
                    .ok_or("decoder input too large")?,
            );

            let (_, _, errors) = decoder.decode_to_string(&bytes, &mut output, last);

            if errors && p["fatal"].as_bool() == Some(true) {
                return Err("invalid encoded text".into());
            }

            Ok(json!(output))
        }
        "closeDecoder" => {
            r.decoders.remove(&id(p)?);

            Ok(Json::Null)
        }
        _ => unreachable!("dispatched web operation"),
    }
}
