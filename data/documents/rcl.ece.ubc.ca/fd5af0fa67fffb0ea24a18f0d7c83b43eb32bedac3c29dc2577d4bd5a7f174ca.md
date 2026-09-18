---
{
  "format_version": 1,
  "id": "documents:official-web:dfc791b4c0d8c1e845337748",
  "hostname": "rcl.ece.ubc.ca",
  "title": "Diagnostic Ultrasound",
  "source_url": "https://rcl.ece.ubc.ca/research/diagnostic-ultrasound/",
  "retrieved_at": "2026-09-18T12:52:28.817Z",
  "source_modified_at": "2014-07-18T20:56:28Z",
  "snapshot_sha256": "985618e446b8f883cce3b10a38a975466ee91ab193e48398a169fd15800e9281",
  "input_sha256": "73021a227c3d7776763a21edef081d7938b507fafb4a8e2e142cf7b8d0ca2cfd",
  "body_sha256": "9db53e22b017ea5840cb43aa58b98fc14dd1ac46059bf7fc0de3a11bf7944c55",
  "content_sha256": "8d600aa65dff9b43ce3488b6723290cc934df7f4b20df84f793c14b6f1767a64",
  "warnings": [],
  "alternate_urls": [],
  "producer": {
    "inputs_sha256": "383c8917b7e13d2670e16d3ff692b2c05d60c2d9532895cc5b5ec092115f8737",
    "runtime": {
      "node": "26.8.1",
      "icu": "78.3",
      "unicode": "17.0",
      "platform": "linux",
      "arch": "x64"
    }
  }
}
---
#### Prostate Cancer Diagnosis

[https://rcl\-ece\.sites\.olt\.ubc\.ca/files/2014/07/7cases\.jpg](https://rcl-ece.sites.olt.ubc.ca/files/2014/07/7cases.jpg)[7cases](https://rcl-ece.sites.olt.ubc.ca/files/2014/07/7cases.jpg)  
With an annual death toll of over 4200 in Canada, and more than 500,000 new cases per year in the Western hemisphere, prostate cancer is the most prevalent type of cancer and second leading cancer\-related cause of death in men\. The routine diagnostic method for prostate cancer is histopathologic analysis of tissue samples acquired through biopsy\. An ultrasound\-based system that detects and displays the cancerous areas of the tissue while the radiologist is performing the biopsy has been sought for a number of years now\. If achieved, such a system will reduce the high number of unfortunate false negative biopsy outcomes\. However, the traditional methods of analyzing ultrasound data in search for features that characterize cancerous tissue have met little success\.

To tackle this problem, we are devising a new approach to ultrasound data collection\. The basic concept is simple: we propose that for higher accuracy of detection, we need more than just one snapshot of the tissue\. We collect a sequence of ultrasound frames from a given intersection of tissue\. The sequence of one sample of one ultrasound echo signal recorded over time results in a time series\. We have acquired sensitivity and accuracy values of up to 90% in finding cancer in prostate tissue\. For further details, please refer to [Moradi et al\.](http://scholar.google.com/scholar?cluster=816824990026098439&amp;hl=en&amp;as_sdt=2000)