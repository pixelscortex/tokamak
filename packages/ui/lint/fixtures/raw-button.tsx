import { Row } from "@tokamak/ui";

export const RawButton = () => (
  <>
    <button type="button">Back</button>
    <Row render={(attrs) => <button type="button" {...attrs} />}>New thread</Row>
  </>
);
